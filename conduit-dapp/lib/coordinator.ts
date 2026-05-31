/**
 * The coordinator agent + the A2A orchestration that drives the Conduit console.
 *
 * Flow: user prompt → coordinator REASONS (pluggable: stub now, Venice text
 * later) → a plan of catalog services to buy → for each, the coordinator hands a
 * scoped task to a specialist sub-agent via an A2A message envelope → the
 * sub-agent pays its service through Conduit (real on-chain redelegation).
 *
 * Two A2A modes (both real on-chain):
 *   - "looped" : the coordinator pays each service directly (2-hop). Reliable;
 *     every service is a real, separately-bound, separately-settled payment.
 *   - "a2a"    : each specialist is its own key; coordinator → specialist →
 *     relayer (3-hop). The literal "agents delegating to agents".
 */
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { formatUnits, parseUnits, type Hex } from "viem";
import { fetchCatalog, fetch402, payAndClaim, type CatalogService } from "./endpoint";
import { buildPayment, freshIntentHash } from "./payment";
import { publicClient } from "./chain";
import type { Coordinator, GrantResult } from "./grant";
import type { Eip7702Authorization } from "./payment";

/** A specialist sub-agent identity (an ephemeral key, like the coordinator). */
export type Agent = Coordinator;

export function createAgent(): Agent {
  const privateKey = generatePrivateKey();
  return { privateKey, address: privateKeyToAccount(privateKey).address };
}

/** One planned purchase the coordinator decided to make. */
export interface PlanItem {
  service: CatalogService;
  /** The specialist role label shown in the console (e.g. "image", "data"). */
  agent: string;
  /** Why the coordinator chose it (reasoning, surfaced in the UI). */
  rationale: string;
}

/** A plan item with its assigned correlation id (ties client card ↔ SSE events). */
export interface PlannedItem extends PlanItem {
  correlationId: string;
}

/** The A2A message envelope the coordinator hands to each specialist. */
export interface A2ATask {
  from: "coordinator";
  to: string; // specialist label
  taskId: string;
  service: string; // catalog service id
  intent: string; // human description
  budgetCap: string; // base units the specialist may spend (= the price)
}

// --- Reasoning (pluggable) -------------------------------------------------

export interface Planner {
  plan(prompt: string, catalog: CatalogService[]): Promise<PlanItem[]>;
}

/**
 * Deterministic stub planner — maps prompt keywords to services so the demo
 * works with no API key. Swapped for the Venice text planner once a key exists
 * (same interface). Always returns at least one item.
 */
export const stubPlanner: Planner = {
  async plan(prompt, catalog) {
    const p = prompt.toLowerCase();
    const want = (id: string) => catalog.find((s) => s.id === id);
    const picks: PlanItem[] = [];
    const add = (id: string, agent: string, rationale: string) => {
      const service = want(id);
      if (service) picks.push({ service, agent, rationale });
    };

    if (/(image|logo|art|cover|visual|design|brand)/.test(p))
      add("venice-image", "image", "Prompt asks for a visual asset.");
    if (/(copy|tagline|caption|text|slogan|post|write|content)/.test(p))
      add("copywriting", "copy", "Prompt needs written copy.");
    if (/(market|price|trend|data)/.test(p))
      add("market-data", "data", "Prompt needs market data.");
    if (/(competitor|rival|landscape|compare)/.test(p))
      add("competitor-scan", "research", "Prompt needs competitor analysis.");

    // Fallback: if nothing matched, do a sensible default mini-campaign.
    if (picks.length === 0) {
      add("venice-image", "image", "Default: produce a visual.");
      add("copywriting", "copy", "Default: produce copy.");
    }
    return picks;
  },
};

// --- Orchestration ---------------------------------------------------------

export type A2AMode = "looped" | "a2a";

export interface RunHooks {
  /** Coordinator reasoning / planning narration (each item has a correlationId). */
  onPlan?: (items: PlannedItem[]) => void;
  /** A payment is about to be attempted (card → "paying"). */
  onPayStart?: (correlationId: string) => void;
  /** An A2A task handed to a specialist (the envelope). */
  onTask?: (task: A2ATask, agentAddress: Hex) => void;
  /** A service purchase result (settled or rejected). */
  onResult?: (r: ServiceResult) => void;
  /** Free-form log line. */
  log?: (text: string) => void;
}

export interface ServiceResult {
  correlationId: string;
  service: CatalogService;
  agent: string;
  ok: boolean;
  intentHash: Hex;
  amount: bigint;
  txHash?: string | null;
  error?: string;
}

export interface RunResult {
  plan: PlanItem[];
  results: ServiceResult[];
  totalSpent: bigint; // base units actually settled
}

/**
 * Execute a prompt end-to-end: plan, then buy each planned service through
 * Conduit. `authorization` (the 7702 auth) is bundled into the FIRST payment
 * only; cleared after. In "a2a" mode each service gets a fresh specialist key.
 */
export async function runCampaign(params: {
  prompt: string;
  grant: GrantResult;
  coordinator: Coordinator;
  mode: A2AMode;
  planner?: Planner;
  /** Consumed by the first payment to designate the user EOA (then cleared). */
  authorization?: Eip7702Authorization | null;
  hooks?: RunHooks;
}): Promise<RunResult> {
  const { prompt, grant, coordinator, mode } = params;
  const planner = params.planner ?? stubPlanner;
  const hooks = params.hooks ?? {};
  const log = hooks.log ?? (() => {});

  log("coordinator › reading the catalog…");
  const catalog = await fetchCatalog();

  log("coordinator › reasoning over the prompt…");
  const rawPlan = await planner.plan(prompt, catalog);
  // Assign a stable correlation id per item so the client cards and the SSE
  // events from the facilitator line up.
  const plan: PlannedItem[] = rawPlan.map((i) => ({
    ...i,
    correlationId: crypto.randomUUID(),
  }));
  hooks.onPlan?.(plan);
  log(`coordinator › plan: ${plan.map((i) => i.service.id).join(", ")}`);

  const results: ServiceResult[] = [];
  let totalSpent = 0n;
  let auth = params.authorization ?? undefined;

  for (const item of plan) {
    const { service, agent, correlationId } = item;

    // A2A: spin up a real specialist key and hand it the task envelope.
    let subAgent: Agent | undefined;
    if (mode === "a2a") {
      subAgent = createAgent();
      const task: A2ATask = {
        from: "coordinator",
        to: agent,
        taskId: correlationId,
        service: service.id,
        intent: item.rationale,
        budgetCap: service.priceBaseUnits,
      };
      hooks.onTask?.(task, subAgent.address);
      log(`coordinator → ${agent} › task: buy ${service.label} (cap ${service.priceUsdc} USDC)`);
    }

    // Read the service's 402, build the (intent-bound) payment, pay through Conduit.
    let result: ServiceResult;
    try {
      const req = await fetch402(service.resource);
      const intentHash = freshIntentHash(req);
      const built = await buildPayment({
        grant,
        coordinator,
        req,
        intentHash,
        subAgent,
        authorization: auth,
      });
      const carriesDesignation = !!auth;
      hooks.onPayStart?.(correlationId);
      const claim = await payAndClaim(built.paymentPayload, {
        path: service.resource,
        agent,
        correlationId,
      });
      if (claim.ok) {
        totalSpent += built.amount;
        result = {
          correlationId, service, agent, ok: true, intentHash, amount: built.amount,
          txHash: claim.settlement?.transaction ?? null,
        };
        log(`${agent} › settled ${service.label} · ${formatUnits(built.amount, 6)} USDC`);
        // If this payment carried the EIP-7702 designation, the next payments
        // depend on the account actually HAVING code on-chain. /settle returns
        // 'pending' before the tx mines, so wait for that tx to confirm before
        // firing subsequent redeems (else they hit a still-code-less EOA).
        if (carriesDesignation) {
          auth = undefined;
          const tx = claim.settlement?.transaction as Hex | undefined;
          if (tx) {
            log("coordinator › awaiting 7702 designation confirmation…");
            try {
              await publicClient.waitForTransactionReceipt({ hash: tx });
              log("coordinator › account upgraded to a smart account ✓");
            } catch {
              /* best effort — the per-payment verify will still gate correctness */
            }
          }
        }
      } else {
        result = {
          correlationId, service, agent, ok: false, intentHash, amount: built.amount,
          error: claim.error,
        };
        log(`${agent} › rejected · ${claim.error}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result = {
        correlationId, service, agent, ok: false, intentHash: "0x" as Hex,
        amount: 0n, error: msg,
      };
      log(`${agent} › failed · ${msg}`);
    }
    results.push(result);
    hooks.onResult?.(result);
  }

  return { plan, results, totalSpent };
}

// --- The compromised-agent beat (real on-chain rejections) -----------------

export type RogueKind = "redirect" | "overspend" | "replay";

export interface RogueAttempt {
  correlationId: string;
  kind: RogueKind;
  label: string;
  rationale: string;
  service: CatalogService;
}

const ROGUE_META: Record<RogueKind, { label: string; rationale: string }> = {
  redirect: {
    label: "Redirect funds",
    rationale: "A hijacked agent tries to send the payment to its OWN address.",
  },
  overspend: {
    label: "Overspend",
    rationale: "A hijacked agent tries to pay far more than the bound amount.",
  },
  replay: {
    label: "Replay",
    rationale: "A hijacked agent replays an already-used payment intent.",
  },
};

/**
 * Attempt a deliberately-malicious payment and let Conduit reject it ON-CHAIN.
 * This is the safety thesis made visible: the agent is "compromised" but the
 * caveats make misuse impossible.
 *   - redirect : execution pays a rogue address ≠ the bound recipient
 *                → X402ReceiptEnforcer: wrong-recipient
 *   - overspend: execution amount > the bound maxAmount
 *                → X402ReceiptEnforcer: amount-exceeds-cap
 *   - replay   : reuse a prior intentHash (one-shot id already consumed)
 *                → IdEnforcer: id already used
 */
export async function attemptRogue(params: {
  kind: RogueKind;
  grant: GrantResult;
  coordinator: Coordinator;
  /** A prior successful intentHash, required for the replay attempt. */
  priorIntentHash?: Hex;
  hooks?: RunHooks;
}): Promise<ServiceResult> {
  const { kind, grant, coordinator } = params;
  const hooks = params.hooks ?? {};
  const log = hooks.log ?? (() => {});
  const correlationId = crypto.randomUUID();

  const catalog = await fetchCatalog();
  // Use the cheapest service as the target of the attack.
  const service = [...catalog].sort(
    (a, b) => Number(a.priceBaseUnits) - Number(b.priceBaseUnits)
  )[0];
  const meta = ROGUE_META[kind];

  const result = (over: Partial<ServiceResult>): ServiceResult => ({
    correlationId, service, agent: "rogue", ok: false,
    intentHash: "0x" as Hex, amount: 0n, ...over,
  });

  try {
    const req = await fetch402(service.resource);
    // The malicious twist per attack kind:
    const rogueAddress = privateKeyToAccount(generatePrivateKey()).address;
    const intentHash =
      kind === "replay" ? params.priorIntentHash : freshIntentHash(req);
    if (kind === "replay" && !intentHash) {
      return result({ error: "run a successful payment first, then replay it" });
    }

    const built = await buildPayment({
      grant,
      coordinator,
      req,
      intentHash,
      // redirect: execution target ≠ bound recipient.
      payToOverride: kind === "redirect" ? rogueAddress : undefined,
      // overspend: execution amount far above the bound cap.
      amountOverride:
        kind === "overspend" ? parseUnits("5", 6) : undefined,
    });

    hooks.onPayStart?.(correlationId);
    log(`rogue › ${meta.label} — submitting a malicious redemption…`);
    const claim = await payAndClaim(built.paymentPayload, {
      path: service.resource,
      agent: "rogue",
      correlationId,
    });

    if (claim.ok) {
      // Should never happen — surfaced loudly if it ever does.
      log(`⚠ rogue › UNEXPECTEDLY SETTLED — investigate the caveats`);
      return result({ ok: true, intentHash: intentHash!, txHash: claim.settlement?.transaction ?? null });
    }
    log(`rogue › BLOCKED on-chain · ${claim.error}`);
    return result({ error: claim.error, intentHash: intentHash ?? ("0x" as Hex) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`rogue › blocked · ${msg}`);
    return result({ error: msg });
  }
}

export function rogueCard(kind: RogueKind, correlationId: string) {
  return { ...ROGUE_META[kind], kind, correlationId };
}

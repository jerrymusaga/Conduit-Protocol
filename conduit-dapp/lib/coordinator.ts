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
import { buildPayment, buildOneshotPayment, freshIntentHash } from "./payment";
import { publicClient } from "./chain";
import { discoverAgents, type DiscoveredAgent } from "./discovery";
import type { AgentRole } from "./agents";
import type { Coordinator, GrantResult } from "./grant";
import type { Eip7702Authorization } from "./payment";

/** A specialist sub-agent identity (an ephemeral key, like the coordinator). */
export type Agent = Coordinator;

export function createAgent(): Agent {
  const privateKey = generatePrivateKey();
  return { privateKey, address: privateKeyToAccount(privateKey).address };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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

// --- Planning: pick the BEST agent per role the prompt needs ----------------

function roleKind(role: AgentRole): CatalogService["kind"] {
  switch (role) {
    case "image": return "image";
    case "voice": return "audio";
    case "onchain": return "data";
    case "feed": return "subscription";
    default: return "text"; // research, copy, analysis
  }
}

/** A discovered agent → the payment-flow service shape (resource + price). */
function agentToService(a: DiscoveredAgent): CatalogService {
  return {
    id: a.id,
    label: a.name,
    description: a.description,
    kind: roleKind(a.role),
    priceUsdc: a.priceUsdc,
    priceBaseUnits: parseUnits(a.priceUsdc, 6).toString(),
    resource: a.resource,
  };
}

/** Which roles a prompt needs. `always` roles are included in every plan
 *  (research grounds any brief; the narrator voices every deliverable). */
const ROLE_RULES: { role: AgentRole; test: RegExp; always?: boolean; why: string }[] = [
  { role: "research", test: /.^/, always: true, why: "Research the topic." },
  { role: "copy", test: /(brief|copy|launch|positioning|announce|write|marketing|pitch|tagline)/, why: "Write the brief / copy." },
  { role: "image", test: /(cover|image|visual|illustrat|design|art|graphic|logo|poster)/, why: "Design a cover image." },
  { role: "analysis", test: /(analy|market|compar|competit|outlook|assess|risk|trend|insight|strategy)/, why: "Analyze the landscape." },
  { role: "onchain", test: /(eth|staking|on-?chain|crypto|token|defi|tvl|validator|wallet|blockchain|web3)/, why: "Pull real on-chain data." },
  { role: "voice", test: /.^/, always: true, why: "Narrate a voiceover summary." },
];

/**
 * Deterministic best-per-role planner. From the prompt + the discovered
 * marketplace, decide which roles the task needs and pick the BEST agent for
 * each: premium prompts get the highest-quality (priciest) provider, otherwise
 * the best value (cheapest). Surfaces the choice as the rationale.
 */
export function planForPrompt(prompt: string, agents: DiscoveredAgent[]): PlanItem[] {
  const p = prompt.toLowerCase();
  const wantsPremium = /(premium|high[- ]?res|hi[- ]?res|4k|deep|best quality|top[- ]?tier|\bpro\b)/.test(p);
  const picks: PlanItem[] = [];

  for (const rule of ROLE_RULES) {
    if (!rule.always && !rule.test.test(p)) continue;
    const candidates = agents.filter((a) => a.role === rule.role);
    if (candidates.length === 0) continue;
    const sorted = [...candidates].sort((a, b) => Number(a.priceUsdc) - Number(b.priceUsdc));
    const best = wantsPremium ? sorted[sorted.length - 1] : sorted[0];
    const rationale =
      candidates.length > 1
        ? `${rule.why} Picked ${best.name} (${wantsPremium ? "best quality" : "best value"}) over ${candidates.length - 1} other${candidates.length > 2 ? "s" : ""}.`
        : rule.why;
    picks.push({ service: agentToService(best), agent: best.role, rationale });
  }
  return picks;
}

/**
 * Venice-powered selection — the coordinator's REASONING step. Asks /api/plan
 * (Venice) to pick the best agent per capability the prompt needs, with a short
 * rationale each. Returns null on any failure so the caller falls back to the
 * deterministic planForPrompt (so it always works, even with no Venice credits).
 */
export async function planWithVenice(
  prompt: string,
  agents: DiscoveredAgent[]
): Promise<PlanItem[] | null> {
  try {
    const res = await fetch("/api/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt,
        agents: agents.map((a) => ({
          id: a.id, name: a.name, role: a.role, priceUsdc: a.priceUsdc, description: a.description,
        })),
      }),
    });
    if (!res.ok) return null;
    const { picks } = (await res.json()) as { picks?: { id: string; reason?: string }[] | null };
    if (!picks || picks.length === 0) return null;
    const items: PlanItem[] = [];
    const seen = new Set<string>();
    for (const p of picks) {
      if (seen.has(p.id)) continue;
      const agent = agents.find((a) => a.id === p.id);
      if (!agent) continue;
      seen.add(p.id);
      items.push({
        service: agentToService(agent),
        agent: agent.role,
        rationale: p.reason ?? "Selected by the coordinator.",
      });
    }
    return items.length ? items : null;
  } catch {
    return null;
  }
}

// --- Orchestration ---------------------------------------------------------

export type A2AMode = "looped" | "a2a";

export interface RunHooks {
  /** The discovered marketplace (all registered agents) — for the canvas to show
   *  the full set with the chosen ones highlighted. */
  onDiscover?: (agents: DiscoveredAgent[]) => void;
  /** Coordinator reasoning / planning narration (each item has a correlationId). */
  onPlan?: (items: PlannedItem[]) => void;
  /** A payment is about to be attempted (card → "paying"). */
  onPayStart?: (correlationId: string) => void;
  /** An A2A task handed to a specialist (the envelope). */
  onTask?: (task: A2ATask, agentAddress: Hex) => void;
  /** A service purchase result (settled or rejected). */
  onResult?: (r: ServiceResult) => void;
  /** Fired before the run when the plan costs more than the granted budget. */
  onBudgetForecast?: (info: { planTotal: bigint; budget: bigint }) => void;
  /** Free-form log line. */
  log?: (text: string) => void;
}

/** Does a revert reason look like the budget cap (ERC20PeriodTransferEnforcer)
 *  rather than a per-request cap or other failure? In the normal run loop a
 *  payment only fails on amount when the period budget is exhausted. */
export function isBudgetCapRevert(err?: string): boolean {
  return !!err && /period|available/i.test(err);
}

export interface ServiceResult {
  correlationId: string;
  service: CatalogService;
  agent: string;
  ok: boolean;
  intentHash: Hex;
  amount: bigint;
  /** Rejected because it would exceed the granted budget (ERC20PeriodTransferEnforcer). */
  budgetCapped?: boolean;
  txHash?: string | null;
  /** Settlement job id — poll the facilitator's GET /jobs/:id for the on-chain
   *  tx hash + terminal status (settlement is async). */
  jobId?: string;
  error?: string;
  /** The provider's returned output (the purchased data) — fed to the report. */
  output?: unknown;
  /** The exact x402 payload that settled — fuel for a REAL replay attempt
   *  (re-POSTing this verbatim is what IdEnforcer rejects as id-already-used). */
  settledPayload?: unknown;
  /** The catalog resource path the payload was paid against. */
  resourcePath?: string;
  /** For rogue attempts: the x402 attack vector (what malicious field was
   *  crafted vs the bound caveat) — surfaced so the UI can show the attack. */
  attack?: RogueAttack;
}

/** The x402 attack a rogue agent crafted — field-level, for the canvas inspector. */
export interface RogueAttack {
  kind: RogueKind;
  /** redirect: the attacker's own address it tried to redirect payment to. */
  attemptedPayTo?: string;
  /** redirect: the recipient the caveat actually binds payment to (the seller). */
  boundPayTo?: string;
  /** overspend: the inflated amount it tried to spend (human USDC). */
  attemptedAmountUsdc?: string;
  /** overspend: the amount the caveat caps it at (human USDC). */
  boundAmountUsdc?: string;
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
  /** Consumed by the first payment to designate the user EOA (then cleared). */
  authorization?: Eip7702Authorization | null;
  hooks?: RunHooks;
}): Promise<RunResult> {
  const { prompt, grant, coordinator, mode } = params;
  const hooks = params.hooks ?? {};
  const log = hooks.log ?? (() => {});

  // --- Discovery: read the ERC-8004 registry, surface the marketplace --------
  log("coordinator › querying the ERC-8004 agent registry…");
  const market = await discoverAgents();
  const procurement = market.filter((m) => m.paymentKind === "one-shot");
  hooks.onDiscover?.(procurement);
  for (const ag of procurement) {
    await sleep(280);
    const tag = ag.source === "registry" && ag.agentId ? ` · agent #${ag.agentId}` : "";
    log(`coordinator › ✓ ${ag.name} · ${ag.role} · ${ag.priceUsdc} USDC${tag}`);
  }
  await sleep(250);

  // --- Plan: the coordinator reasons (Venice) over the prompt + marketplace -
  log("coordinator › reasoning over the prompt + marketplace…");
  let rawPlan = await planWithVenice(prompt, procurement);
  if (rawPlan && rawPlan.length > 0) {
    log("coordinator › Venice picked the team");
  } else {
    rawPlan = planForPrompt(prompt, procurement);
    log("coordinator › picked the team (rules)");
  }
  // Assign a stable correlation id per item so the client cards and the SSE
  // events from the facilitator line up.
  const plan: PlannedItem[] = rawPlan.map((i) => ({
    ...i,
    correlationId: crypto.randomUUID(),
  }));
  hooks.onPlan?.(plan);
  log(`coordinator › hired: ${plan.map((i) => i.service.label).join(", ")}`);

  // Proactive budget forecast: if the plan costs more than the granted budget,
  // warn up front — the ERC20PeriodTransferEnforcer will block the overflow
  // payments on-chain (the budget-cap safety beat).
  const planTotal = plan.reduce((s, i) => s + BigInt(i.service.priceBaseUnits), 0n);
  if (planTotal > grant.periodAmount) {
    log(
      `coordinator › ⚠ this team costs ${formatUnits(planTotal, 6)} USDC but the budget is ` +
        `${formatUnits(grant.periodAmount, 6)} — the budget cap will block the overflow on-chain`
    );
    hooks.onBudgetForecast?.({ planTotal, budget: grant.periodAmount });
  }

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
      // oneshot-pl needs the structured two-delegation (fee + work) payload;
      // viem-direct uses the single bound redelegation. The 402 says which.
      const built =
        req.relayBackend === "oneshot-pl"
          ? await buildOneshotPayment({ grant, coordinator, req, intentHash, subAgent, authorization: auth })
          : await buildPayment({ grant, coordinator, req, intentHash, subAgent, authorization: auth });
      const carriesDesignation = !!auth;
      hooks.onPayStart?.(correlationId);
      const claim = await payAndClaim(built.paymentPayload, {
        path: service.resource,
        agent,
        correlationId,
        topic: prompt,
      });
      if (claim.ok) {
        totalSpent += built.amount;
        result = {
          correlationId, service, agent, ok: true, intentHash, amount: built.amount,
          txHash: claim.settlement?.transaction ?? null,
          jobId: claim.settlement?.jobId,
          settledPayload: built.paymentPayload,
          resourcePath: service.resource,
          output: claim.data,
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
        const budgetCapped = isBudgetCapRevert(claim.error);
        result = {
          correlationId, service, agent, ok: false, intentHash, amount: built.amount,
          error: claim.error, budgetCapped,
        };
        log(
          budgetCapped
            ? `${agent} › budget cap reached · blocked on-chain · ${claim.error}`
            : `${agent} › rejected · ${claim.error}`
        );
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
  /** The EXACT payload + path from a prior settled payment (for replay). */
  priorSettled?: { payload: unknown; resourcePath: string };
  hooks?: RunHooks;
}): Promise<ServiceResult> {
  const { kind, grant, coordinator } = params;
  const hooks = params.hooks ?? {};
  const log = hooks.log ?? (() => {});
  const correlationId = crypto.randomUUID();
  const meta = ROGUE_META[kind];

  // --- replay: re-POST the EXACT payload that already settled --------------
  // IdEnforcer keys used-ids by (DelegationManager, delegator, id). A genuine
  // replay reuses the same signed delegation (same delegator + id), which the
  // enforcer rejects as id-already-used. (Rebuilding a fresh delegation would
  // get a NEW delegator/id and wrongly succeed — that was the earlier bug.)
  if (kind === "replay") {
    if (!params.priorSettled) {
      return {
        correlationId, service: undefined as never, agent: "rogue", ok: false,
        intentHash: "0x" as Hex, amount: 0n,
        error: "run a successful payment first, then replay it",
      };
    }
    hooks.onPayStart?.(correlationId);
    log("rogue › Replay — re-submitting an already-used payment verbatim…");
    const claim = await payAndClaim(params.priorSettled.payload, {
      path: params.priorSettled.resourcePath,
      agent: "rogue",
      correlationId,
    });
    if (claim.ok) {
      log("⚠ rogue › UNEXPECTEDLY SETTLED — investigate IdEnforcer");
      return {
        correlationId, service: undefined as never, agent: "rogue", ok: true,
        intentHash: "0x" as Hex, amount: 0n,
        txHash: claim.settlement?.transaction ?? null,
      };
    }
    log(`rogue › BLOCKED on-chain · ${claim.error}`);
    return {
      correlationId, service: undefined as never, agent: "rogue", ok: false,
      intentHash: "0x" as Hex, amount: 0n, error: claim.error,
      attack: { kind: "replay" },
    };
  }

  // --- redirect / overspend: build a fresh malicious payment ---------------
  // Target one-shot agents only (subscriptions use a different enforcer/flow).
  const catalog = (await fetchCatalog()).filter((s) => s.kind !== "subscription");
  const cheapest = [...catalog].sort(
    (a, b) => Number(a.priceBaseUnits) - Number(b.priceBaseUnits)
  )[0];
  // Overspend targets a recognizable agent (the Researcher) so the bound
  // per-request cap shown on screen is a real, named service price; redirect
  // uses the cheapest.
  const service =
    kind === "overspend"
      ? catalog.find((s) => s.id === "researcher") ?? cheapest
      : cheapest;

  // Captured after fetch402 so the result carries the real attack values.
  let attack: RogueAttack | undefined;
  const result = (over: Partial<ServiceResult>): ServiceResult => ({
    correlationId, service, agent: "rogue", ok: false,
    intentHash: "0x" as Hex, amount: 0n, attack, ...over,
  });

  try {
    const req = await fetch402(service.resource);
    const rogueAddress = privateKeyToAccount(generatePrivateKey()).address;
    // Overspend a NORMAL-looking amount: clearly ABOVE the per-request cap (so
    // the receipt enforcer must reject it) but clearly BELOW the budget (so the
    // demo makes obvious it's the PER-REQUEST cap doing the work — not
    // MetaMask's budget cap, which would happily allow this).
    const boundCap = BigInt(req.maxAmountRequired);
    let overspendAmount = boundCap * 20n; // e.g. $0.05 cap → $1.00 attempt
    if (overspendAmount >= grant.periodAmount) overspendAmount = grant.periodAmount / 2n;
    if (overspendAmount <= boundCap) overspendAmount = boundCap * 2n;
    attack =
      kind === "redirect"
        ? { kind, attemptedPayTo: rogueAddress, boundPayTo: req.payTo }
        : {
            kind,
            attemptedAmountUsdc: Number(formatUnits(overspendAmount, 6)).toFixed(2),
            boundAmountUsdc: formatUnits(boundCap, 6),
          };
    const built = await buildPayment({
      grant,
      coordinator,
      req,
      intentHash: freshIntentHash(req),
      // redirect: execution target ≠ bound recipient.
      payToOverride: kind === "redirect" ? rogueAddress : undefined,
      // overspend: a normal-sized amount that fits the budget but exceeds this
      // request's bound cap → X402ReceiptEnforcer: amount-exceeds-cap.
      amountOverride: kind === "overspend" ? overspendAmount : undefined,
    });

    hooks.onPayStart?.(correlationId);
    log(`rogue › ${meta.label} — submitting a malicious redemption…`);
    const claim = await payAndClaim(built.paymentPayload, {
      path: service.resource,
      agent: "rogue",
      correlationId,
    });

    if (claim.ok) {
      log(`⚠ rogue › UNEXPECTEDLY SETTLED — investigate the caveats`);
      return result({ ok: true, txHash: claim.settlement?.transaction ?? null });
    }
    log(`rogue › BLOCKED on-chain · ${claim.error}`);
    return result({ error: claim.error });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`rogue › blocked · ${msg}`);
    return result({ error: msg });
  }
}

export function rogueCard(kind: RogueKind, correlationId: string) {
  return { ...ROGUE_META[kind], kind, correlationId };
}

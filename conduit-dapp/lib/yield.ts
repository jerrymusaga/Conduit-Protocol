/**
 * Yield deposits — a delegated lending-pool supply the agent CANNOT abuse, bounded
 * on-chain by YieldAllowlistEnforcer. The yield sibling of trade.ts.
 *
 * Where trade.ts lets a scout pick the best TOKEN from a signed set and a trader
 * swap into it, this lets a scout pick the best VENUE (the highest APY) from a
 * signed set of lending pools and a "deposit" agent supply USDC into it — without
 * the user re-signing. A hijacked agent still cannot supply into a venue you
 * didn't approve, overspend the cap, supply a different asset, or redirect the
 * interest-bearing position (the yield) to itself.
 *
 * Settlement reuses the execution-agnostic oneshot path: an open leaf
 * (coordinator → relayer) under the YieldAllowlist root + the `supply` execution +
 * an ApproveBounds leg (the pool pulls USDC via transferFrom) + the bounded fee leg
 * → one redeemDelegations via 1Shot. Gas paid in USDC; the user never needs ETH.
 *
 * The deposit primitive is Aave-V3 `supply(asset, amount, onBehalfOf, referralCode)`,
 * which Aave's own market and its address-compatible Base forks (Seamless, etc.)
 * all expose — so one enforcer covers the whole venue set.
 */
import { signDelegation } from "@metamask/smart-accounts-kit/actions";
import {
  decodeDelegations,
  encodeDelegations,
  hashDelegation,
  encodeExecutionCalldata,
} from "@metamask/smart-accounts-kit/utils";
import {
  createExecution,
  signDelegation as signDelegationWithKey,
} from "@metamask/smart-accounts-kit";
import {
  encodeFunctionData,
  encodePacked,
  keccak256,
  parseAbi,
  toHex,
  type Hex,
  type WalletClient,
} from "viem";
import { config } from "./config";
import type { Coordinator, GrantResult } from "./grant";
import { grantBudget } from "./grant";
import {
  buildBoundChain,
  feeCapAtoms,
  type Delegation,
  type Eip7702Authorization,
} from "./payment";
import type { PaymentRequirements } from "./endpoint";
import { encodeApproveTerms, encodeApproveCalldata } from "./trade";

const ROOT_AUTHORITY: Hex = `0x${"f".repeat(64)}` as Hex;

// Aave-V3 Pool — the deposit venue YieldAllowlistEnforcer guards.
const AAVE_POOL_ABI = parseAbi([
  "function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)",
]);

export interface YieldVenue {
  /** Friendly name for normal users, e.g. "Aave V3". */
  name: string;
  /** The lending protocol family (all Aave-V3-`supply`-compatible). */
  protocol: string;
  /** The Pool contract the supply targets (the allowlist entry). */
  pool: Hex;
  /** A short hint the scout reasons over (and a rough APY band for display). */
  note: string;
}

// The CURATED set of yield venues a user can authorise — vetted Aave-V3-compatible
// lending pools on Base (never an arbitrary pool: a malicious "pool" could swallow
// the deposit, so the allowlist is the safety primitive). The agent can only ever
// supply into this set, so the scout's "best APY" pick is a real, bounded choice.
//
// IMPORTANT: these are Base MAINNET Pool addresses (where USDC actually earns).
// VERIFY each before the mainnet run. On Base Sepolia there's no Aave market with
// USDC liquidity, so a testnet deposit doesn't settle — the authorisation + scout
// pick are real; the live supply is a mainnet thing (exactly like the swap path).
const BASE_VENUES: YieldVenue[] = [
  {
    name: "Aave V3",
    protocol: "Aave",
    pool: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
    note: "Aave V3 Base market — the deepest, most battle-tested USDC lending pool",
  },
  {
    name: "Seamless",
    protocol: "Seamless (Aave V3 fork)",
    pool: "0x8F44Fd754285aa6A2b8B9B97739B79746e0475a7",
    note: "Seamless Protocol — Aave-V3 fork on Base, often a higher USDC supply APY",
  },
  {
    name: "ZeroLend",
    protocol: "ZeroLend (Aave V3 fork)",
    pool: "0x766f21277087E18967c1b10bF602d8Fe56d0c671",
    note: "ZeroLend — Aave-V3 fork on Base, typically the highest USDC supply APY of the three",
  },
];
const YIELD_VENUES: Record<number, YieldVenue[]> = { 8453: BASE_VENUES, 84532: BASE_VENUES };

/** The curated venue set the user can authorise for this chain. */
export function yieldAllowlist(): YieldVenue[] {
  return YIELD_VENUES[config.chainId] ?? YIELD_VENUES[84532];
}

export interface VenueEntry {
  pool: Hex;
  name: string;
  protocol: string;
  /** Per-venue minimum-deposit floor, asset base units (0 = none). */
  minAmount: bigint;
  note: string;
}

export interface YieldGrant {
  context: Hex; // YieldAllowlist root
  /** One ApproveBounds root per venue (token · pool · cap), so the build can pick
   *  the approve matching the scout's chosen venue. */
  approveContexts: { pool: Hex; context: Hex }[];
  delegationManager: Hex;
  delegationHash: Hex;
  asset: Hex;
  maxAmountIn: bigint;
  recipient: Hex;
  venues: VenueEntry[];
  feeGrant: GrantResult;
  expiry: number;
}

/** Pack the YieldAllowlistEnforcer terms:
 *  asset · maxIn · recipient · N · [pool · minAmount]×N. */
function encodeYieldTerms(g: {
  asset: Hex; maxAmountIn: bigint; recipient: Hex; venues: VenueEntry[];
}): Hex {
  const types: string[] = ["address", "uint128", "address", "uint8"];
  const values: unknown[] = [g.asset, g.maxAmountIn, g.recipient, g.venues.length];
  for (const v of g.venues) {
    types.push("address", "uint128");
    values.push(v.pool, v.minAmount);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return encodePacked(types as any, values as any);
}

/** Aave-V3 supply(asset, amount, onBehalfOf, 0) calldata for a bounded deposit. */
export function encodeSupplyCalldata(asset: Hex, amount: bigint, onBehalfOf: Hex): Hex {
  return encodeFunctionData({
    abi: AAVE_POOL_ABI,
    functionName: "supply",
    args: [asset, amount, onBehalfOf, 0],
  });
}

/**
 * Grant a YIELD authorisation over a SET of venues. The user signs a YieldAllowlist
 * root (the curated venue set, each with its own minimum-deposit floor) + an
 * ApproveBounds root (so the pool allowance rides the same 1Shot batch) + a fee
 * budget. A scout later picks the best-APY venue from the set; the Depositor
 * supplies into it without the user re-signing.
 */
export async function grantYieldAllowlist(params: {
  walletClient: WalletClient;
  userAddress: Hex;
  coordinator: Coordinator;
  amountIn: bigint;
  venues?: YieldVenue[];
  /** Optional per-venue minimum-deposit floor (asset base units). Default 0. */
  minAmount?: bigint;
  feeBudgetUsdc?: string;
  expiry?: number;
}): Promise<YieldGrant> {
  const { walletClient, userAddress, coordinator, amountIn } = params;
  const asset = config.usdc;
  const expiry = params.expiry ?? 0;
  const venues = params.venues ?? yieldAllowlist();
  if (venues.length === 0) throw new Error("No yield venues to authorise.");

  const entries: VenueEntry[] = venues.map((v) => ({
    pool: v.pool, name: v.name, protocol: v.protocol, note: v.note,
    minAmount: params.minAmount ?? 0n,
  }));

  const head = { asset, maxAmountIn: amountIn, recipient: userAddress, venues: entries };

  const caveats: { enforcer: Hex; terms: Hex; args: Hex }[] = [
    { enforcer: config.yieldAllowlistEnforcer, terms: encodeYieldTerms(head), args: "0x" as Hex },
  ];
  // ApproveBounds is bound to a SINGLE spender, so we sign one ApproveBounds root
  // PER venue pool (token · pool · cap). The scout picks a venue; the matching
  // approve root authorises exactly that pool's allowance and no other.
  const approveContexts: { pool: Hex; context: Hex }[] = [];

  const signRoot = async (cvs: { enforcer: Hex; terms: Hex; args: Hex }[]) => {
    const unsigned = {
      delegate: coordinator.address, delegator: userAddress, authority: ROOT_AUTHORITY,
      caveats: cvs, salt: toHex(crypto.getRandomValues(new Uint8Array(32))),
    };
    const signature = await signDelegation(walletClient, {
      delegation: unsigned, delegationManager: config.delegationManager,
      chainId: config.chainId, name: "DelegationManager", version: "1",
    });
    return { ...unsigned, signature };
  };

  if (expiry > 0) {
    caveats.push({
      enforcer: config.timestampEnforcer,
      terms: encodePacked(["uint128", "uint128"], [0n, BigInt(expiry)]),
      args: "0x" as Hex,
    });
  }
  const yieldRoot = await signRoot(caveats);

  for (const v of entries) {
    const ac: { enforcer: Hex; terms: Hex; args: Hex }[] = [
      { enforcer: config.approveBoundsEnforcer, terms: encodeApproveTerms(asset, v.pool, amountIn), args: "0x" as Hex },
    ];
    if (expiry > 0) {
      ac.push({ enforcer: config.timestampEnforcer, terms: encodePacked(["uint128", "uint128"], [0n, BigInt(expiry)]), args: "0x" as Hex });
    }
    const root = await signRoot(ac);
    approveContexts.push({ pool: v.pool, context: encodeDelegations([root]) });
  }

  const feeGrant = await grantBudget({
    walletClient, userAddress, coordinator, amountUsdc: params.feeBudgetUsdc ?? "0.30", periodDuration: 3600,
  });

  return {
    context: encodeDelegations([yieldRoot]),
    approveContexts,
    delegationManager: config.delegationManager,
    delegationHash: hashDelegation(yieldRoot as Delegation),
    asset, maxAmountIn: amountIn, recipient: userAddress,
    venues: entries, feeGrant, expiry,
  };
}

export interface BuiltSupply {
  paymentPayload: unknown;
  amountIn: bigint;
}

/** Build the [approve, supply] 1Shot batch for a chosen allowlist venue. */
export async function buildAllowlistSupplyCommission(params: {
  grant: YieldGrant;
  coordinator: Coordinator;
  req: PaymentRequirements;
  pool: Hex;
  amountIn: bigint;
  authorization?: Eip7702Authorization;
  /** Rogue beat: supply into an OFF-allowlist pool so the enforcer (not the
   *  client) rejects it on-chain (YieldAllow:venue-not-allowed). */
  allowOffList?: boolean;
  recipientOverride?: Hex;
}): Promise<BuiltSupply> {
  const { grant, coordinator, req, pool, amountIn } = params;
  if (!req.redeemer) throw new Error("facilitator advertised no redeemer (targetAddress)");
  if (!req.feeCollector) throw new Error("facilitator advertised no feeCollector (oneshot-pl)");
  const entry = grant.venues.find((v) => v.pool.toLowerCase() === pool.toLowerCase());
  if (!entry && !params.allowOffList) throw new Error("chosen venue is not in the signed allowlist");

  const redeemer = req.redeemer;
  const rootDelegator = decodeDelegations(grant.context).slice(-1)[0].delegator;

  // The ApproveBounds root that authorises THIS pool's allowance (per-venue).
  const approveCtx =
    grant.approveContexts.find((a) => a.pool.toLowerCase() === pool.toLowerCase())?.context
    ?? grant.approveContexts[0]?.context;
  if (!approveCtx) throw new Error("no ApproveBounds root for the chosen venue");

  const openLeafChain = async (rootContext: Hex): Promise<Delegation[]> => {
    const rootChain = decodeDelegations(rootContext);
    const root = rootChain[0];
    const unsignedLeaf: Omit<Delegation, "signature"> = {
      delegate: redeemer, delegator: coordinator.address, authority: hashDelegation(root),
      caveats: [], salt: toHex(crypto.getRandomValues(new Uint8Array(32))),
    };
    const sig = await signDelegationWithKey({
      privateKey: coordinator.privateKey, delegation: unsignedLeaf,
      delegationManager: grant.delegationManager, chainId: config.chainId,
      name: "DelegationManager", version: "1", allowInsecureUnrestrictedDelegation: true,
    });
    return [{ ...unsignedLeaf, signature: sig }, ...rootChain];
  };

  const onBehalfOf = params.recipientOverride ?? grant.recipient;
  const supplyCalldata = encodeSupplyCalldata(grant.asset, amountIn, onBehalfOf);

  const [approveChain, supplyChain] = await Promise.all([
    openLeafChain(approveCtx),
    openLeafChain(grant.context),
  ]);
  const works = [
    { chain: approveChain, execution: { target: grant.asset, value: "0", data: encodeApproveCalldata(pool, amountIn) } },
    { chain: supplyChain, execution: { target: pool, value: "0", data: supplyCalldata } },
  ];

  const feeIntent = keccak256(toHex(crypto.getRandomValues(new Uint8Array(32))));
  const feeChain = await buildBoundChain({
    grant: grant.feeGrant, coordinator, redeemer, token: config.usdc,
    recipient: req.feeCollector, maxAmount: feeCapAtoms(req.feeEstimate), intentHash: feeIntent,
  });

  const paymentPayload = {
    x402Version: 2, scheme: req.scheme, network: req.network,
    payload: {
      delegationManager: grant.delegationManager,
      permissionContext: encodeDelegations(supplyChain),
      delegator: rootDelegator,
      executionCallData: encodeExecutionCalldata([
        createExecution({ target: pool, value: 0n, callData: supplyCalldata }),
      ]),
      ...(params.authorization ? { authorization: params.authorization } : {}),
      oneshot: { paymentToken: config.usdc, works, feeChain },
    },
  };
  return { paymentPayload, amountIn };
}

// --- the Yield Scout: pick the best-APY venue from the SIGNED set --------------

export interface ScoutedVenue {
  entry: VenueEntry;
  /** APY in basis points the scout reasoned over (when available). */
  apyBps?: number;
  rationale: string;
  live: boolean;
}

/** Deterministic venue pick: prefer a fork that historically out-yields the base
 *  market, else the deepest pool. Always constrained to the signed set. */
export function scoutVenue(goal: string, venues: VenueEntry[]): { entry: VenueEntry; rationale: string } {
  const wantsSafe = /(safe|secure|battle|blue.?chip)/i.test(goal) || /\baave\b/i.test(goal);
  const pick =
    // Safety-leaning prompt → the deepest, most battle-tested pool (Aave proper).
    (wantsSafe && venues.find((v) => /^aave/i.test(v.protocol))) ||
    // Default (yield-leaning): prefer the highest-APY fork, ZeroLend first.
    venues.find((v) => /zerolend/i.test(v.protocol)) ||
    venues.find((v) => /fork|seamless|moonwell|morpho/i.test(v.protocol)) ||
    venues[0];
  const rationale = wantsSafe
    ? `Prompt favours safety → ${pick.name} (${pick.note}) from your authorised venues.`
    : `${pick.name} (${pick.note}) — best yield in your authorised venues.`;
  return { entry: pick, rationale };
}

/** The Venice-powered Yield Scout: real reasoning over the SIGNED venue set with
 *  live APY context, falling back to the deterministic pick if Venice is
 *  unavailable. The choice is always constrained to the allowlist. */
export async function veniceYieldScout(goal: string, venues: VenueEntry[]): Promise<ScoutedVenue> {
  try {
    const res = await fetch("/api/yield-scout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal, venues: venues.map((v) => ({ name: v.name, protocol: v.protocol, note: v.note })) }),
    });
    if (res.ok) {
      const j = (await res.json()) as { pick?: { name?: string; apyBps?: number; reason?: string } | null };
      const name = j.pick?.name;
      const entry = name ? venues.find((v) => v.name.toLowerCase() === name.toLowerCase()) : undefined;
      if (entry) {
        return {
          entry, apyBps: j.pick?.apyBps,
          rationale: j.pick?.reason || `${entry.name} — the Scout's best-APY pick from your approved venues.`,
          live: true,
        };
      }
    }
  } catch {
    /* fall through to the deterministic scout */
  }
  const det = scoutVenue(goal, venues);
  return { entry: det.entry, rationale: det.rationale, live: false };
}

// --- prompt understanding ------------------------------------------------------

/** Does the prompt ask the agent to DEPOSIT funds into a lending venue (supply
 *  for yield), as opposed to a token swap? Matches deposit verbs + lending/venue
 *  language (incl. protocol names + "venue/APY"). Generic "yield"/"stake" alone
 *  still stays with the swap path (e.g. "swap into staked-ETH"), so this never
 *  clobbers the trade flow — but "yield venue(s)" is unambiguously a deposit.
 *  Routing checks this BEFORE trade. */
export function isYieldIntent(prompt: string): boolean {
  const p = prompt.toLowerCase();
  // Deposit-specific / lending-venue signals.
  if (/\b(lend|lending|supply|deposit|venue|venues|apy|apr|aave|moonwell|seamless|zerolend|morpho|park\s+(?:my\s+)?(?:usdc|funds|cash|stable))\b/.test(p)) {
    return true;
  }
  // "yield" counts as a deposit signal only with lending/venue context (not a
  // swap into a yield-bearing token).
  return /\byield\b/.test(p) && /\b(venue|venues|pool|pools|lend|lending|deposit|supply|protocol|apy|apr)\b/.test(p);
}

/** Parse a yield prompt → deposit amount (USDC). Defaults to 20 USDC. */
export function parseYieldIntent(prompt: string): { amountInUsdc: number } {
  const p = prompt.toLowerCase();
  const amt = p.match(/\$?\s*(\d+(?:\.\d+)?)\s*(?:usdc|dollars?|\$)/) ?? p.match(/\$\s*(\d+(?:\.\d+)?)/);
  const amountInUsdc = amt ? Math.max(0, Number(amt[1])) : 20;
  return { amountInUsdc: amountInUsdc || 20 };
}

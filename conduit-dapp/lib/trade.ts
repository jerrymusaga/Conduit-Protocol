/**
 * Trading — a delegated DEX swap the agent CANNOT abuse, bounded on-chain by
 * SwapBoundsEnforcer. The trading sibling of payments/subscriptions.
 *
 * Shape (mirrors subscription's two-root design):
 *   - SWAP grant: the user signs a root delegation carrying SwapBoundsEnforcer —
 *     router · pair · max-in · min-out (slippage floor) · recipient (the user).
 *     A coordinator narrows-not-widens; a hijacked agent can't rug-swap,
 *     overspend, accept a bad fill, or redirect the proceeds.
 *   - FEE grant: a small bounded USDC budget so 1Shot recoups gas in stablecoin.
 *
 * Settlement reuses the execution-agnostic oneshot path: an open leaf
 * (coordinator → relayer) under the SwapBounds root + the exactInputSingle
 * execution + the bounded fee leg → one redeemDelegations via 1Shot. The user
 * approves the Uniswap router once (a direct tx — Uniswap only pulls from the
 * caller, so the approval is safe).
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
import { publicClient } from "./chain";
import type { Coordinator, GrantResult } from "./grant";
import { grantBudget } from "./grant";
import {
  buildBoundChain,
  feeCapAtoms,
  type Delegation,
  type Eip7702Authorization,
} from "./payment";
import type { PaymentRequirements } from "./endpoint";

const ROOT_AUTHORITY: Hex = `0x${"f".repeat(64)}` as Hex;

// Uniswap v3 SwapRouter02 — the swap venue SwapBoundsEnforcer guards.
const SWAP_ROUTER_ABI = parseAbi([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) returns (uint256)",
]);
const QUOTER_ABI = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);

/** Uniswap QuoterV2 per chain (best-effort slippage-floor pricing). */
const QUOTER: Record<number, Hex> = {
  8453: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a", // Base mainnet
  84532: "0xC5290058841028F1614F3A6F0F5816cAd0df5E27", // Base Sepolia
};

export interface SwapBounds {
  router: Hex;
  tokenIn: Hex;
  tokenOut: Hex;
  /** tokenIn base units — the spend cap. */
  maxAmountIn: bigint;
  /** tokenOut base units — the slippage floor. */
  minAmountOut: bigint;
  /** Who must receive the output (the user). */
  recipient: Hex;
  /** Uniswap pool fee tier. */
  fee: number;
}

export interface SwapGrant {
  context: Hex;
  /** The ApproveBounds root (user → coordinator) authorising the router
   *  allowance — so the approve rides the same 1Shot batch (no ETH needed). */
  approveContext: Hex;
  delegationManager: Hex;
  delegationHash: Hex;
  bounds: SwapBounds;
  /** The bounded gas-fee budget root (funds 1Shot's USDC gas recoup). */
  feeGrant: GrantResult;
  expiry: number;
}

/** Pack the 56-byte ApproveBoundsEnforcer terms: token · spender · maxAmount. */
export function encodeApproveTerms(token: Hex, spender: Hex, maxAmount: bigint): Hex {
  return encodePacked(["address", "address", "uint128"], [token, spender, maxAmount]);
}

/** USDC.approve(router, amount) calldata. */
export function encodeApproveCalldata(spender: Hex, amount: bigint): Hex {
  return encodeFunctionData({
    abi: parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]),
    functionName: "approve",
    args: [spender, amount],
  });
}

/** Pack the 112-byte SwapBoundsEnforcer terms (matches the contract layout). */
export function encodeSwapTerms(b: SwapBounds): Hex {
  return encodePacked(
    ["address", "address", "address", "uint128", "uint128", "address"],
    [b.router, b.tokenIn, b.tokenOut, b.maxAmountIn, b.minAmountOut, b.recipient]
  );
}

/** Uniswap exactInputSingle calldata for a bounded swap (recipient pinned). */
export function encodeSwapCalldata(b: SwapBounds, amountIn: bigint, recipientOverride?: Hex): Hex {
  return encodeFunctionData({
    abi: SWAP_ROUTER_ABI,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: b.tokenIn,
        tokenOut: b.tokenOut,
        fee: b.fee,
        recipient: recipientOverride ?? b.recipient,
        amountIn,
        amountOutMinimum: b.minAmountOut,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });
}

/** Best-effort expected output via Uniswap QuoterV2 (null on testnet w/o a pool). */
export async function quoteExpectedOut(b: Pick<SwapBounds, "tokenIn" | "tokenOut" | "fee">, amountIn: bigint): Promise<bigint | null> {
  const quoter = QUOTER[config.chainId];
  if (!quoter) return null;
  try {
    const { result } = await publicClient.simulateContract({
      address: quoter,
      abi: QUOTER_ABI,
      functionName: "quoteExactInputSingle",
      args: [{ tokenIn: b.tokenIn, tokenOut: b.tokenOut, amountIn, fee: b.fee, sqrtPriceLimitX96: 0n }],
    });
    return (result as readonly [bigint, bigint, number, bigint])[0];
  } catch {
    return null;
  }
}

/**
 * Resolve the full swap bounds for an amount + slippage: quote the expected
 * output (best-effort) and set the floor at `expected × (1 − slippage)`. When no
 * quote is available (testnet, no pool) the floor is a nominal 1 unit — the
 * pair/cap/recipient guarantees still hold, and the happy-path swap demos on
 * mainnet where the quote works.
 */
export async function resolveSwapBounds(params: {
  recipient: Hex;
  amountIn: bigint;
  slippageBps: number;
  tokenIn?: Hex;
  tokenOut?: Hex;
  fee?: number;
}): Promise<SwapBounds> {
  const tokenIn = params.tokenIn ?? config.usdc;
  const tokenOut = params.tokenOut ?? config.weth;
  const fee = params.fee ?? 500;
  const expected = await quoteExpectedOut({ tokenIn, tokenOut, fee }, params.amountIn);
  let minAmountOut: bigint;
  if (expected && expected > 0n) {
    minAmountOut = (expected * BigInt(10_000 - params.slippageBps)) / 10_000n;
  } else if (config.chainId === 8453) {
    // PRODUCTION (mainnet): never trade without a real slippage floor — a
    // nominal floor would let the swap accept any fill. Refuse instead.
    throw new Error("Couldn't price this swap (no Uniswap quote) — refusing to trade without a slippage floor.");
  } else {
    // Testnet only: no liquidity to quote against, so a nominal floor lets the
    // rogue/blocked beat demo anyway. The happy-path swap runs on mainnet.
    minAmountOut = 1n;
  }
  return {
    router: config.uniswapRouter,
    tokenIn,
    tokenOut,
    maxAmountIn: params.amountIn,
    minAmountOut,
    recipient: params.recipient,
    fee,
  };
}

/**
 * Grant a SWAP authorization. The user signs a root delegation carrying
 * SwapBoundsEnforcer (the bounds) + a small gas-fee budget root. Two signTypedData
 * prompts (Privy embedded → instant), like grantSubscription.
 */
export async function grantSwap(params: {
  walletClient: WalletClient;
  userAddress: Hex;
  coordinator: Coordinator;
  bounds: SwapBounds;
  feeBudgetUsdc?: string;
  /** Unix seconds the authorization expires. 0/undefined = none. */
  expiry?: number;
}): Promise<SwapGrant> {
  const { walletClient, userAddress, coordinator, bounds } = params;
  const expiry = params.expiry ?? 0;

  const caveats: { enforcer: Hex; terms: Hex; args: Hex }[] = [
    { enforcer: config.swapBoundsEnforcer, terms: encodeSwapTerms(bounds), args: "0x" as Hex },
  ];
  if (expiry > 0) {
    caveats.push({
      enforcer: config.timestampEnforcer,
      terms: encodePacked(["uint128", "uint128"], [0n, BigInt(expiry)]),
      args: "0x" as Hex,
    });
  }

  const salt = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const unsignedRoot = { delegate: coordinator.address, delegator: userAddress, authority: ROOT_AUTHORITY, caveats, salt };
  const signature = await signDelegation(walletClient, {
    delegation: unsignedRoot,
    delegationManager: config.delegationManager,
    chainId: config.chainId,
    name: "DelegationManager",
    version: "1",
  });
  const signedRoot = { ...unsignedRoot, signature };

  // ApproveBounds root — authorises the exact router allowance the swap needs, so
  // the approve can ride the same 1Shot batch (gas in USDC; no ETH). Bounded to
  // token + the SwapBounds router + the same cap, with the same expiry.
  const approveCaveats: { enforcer: Hex; terms: Hex; args: Hex }[] = [
    {
      enforcer: config.approveBoundsEnforcer,
      terms: encodeApproveTerms(bounds.tokenIn, bounds.router, bounds.maxAmountIn),
      args: "0x" as Hex,
    },
  ];
  if (expiry > 0) {
    approveCaveats.push({
      enforcer: config.timestampEnforcer,
      terms: encodePacked(["uint128", "uint128"], [0n, BigInt(expiry)]),
      args: "0x" as Hex,
    });
  }
  const unsignedApprove = {
    delegate: coordinator.address,
    delegator: userAddress,
    authority: ROOT_AUTHORITY,
    caveats: approveCaveats,
    salt: toHex(crypto.getRandomValues(new Uint8Array(32))),
  };
  const approveSig = await signDelegation(walletClient, {
    delegation: unsignedApprove,
    delegationManager: config.delegationManager,
    chainId: config.chainId,
    name: "DelegationManager",
    version: "1",
  });
  const signedApprove = { ...unsignedApprove, signature: approveSig };

  const feeGrant = await grantBudget({
    walletClient,
    userAddress,
    coordinator,
    amountUsdc: params.feeBudgetUsdc ?? "0.30",
    periodDuration: 3600,
  });

  return {
    context: encodeDelegations([signedRoot]),
    approveContext: encodeDelegations([signedApprove]),
    delegationManager: config.delegationManager,
    delegationHash: hashDelegation(signedRoot as Delegation),
    bounds,
    feeGrant,
    expiry,
  };
}

export interface BuiltSwap {
  paymentPayload: unknown;
  amountIn: bigint;
}

/**
 * Build the 1Shot payload for a bounded swap: an open leaf (coordinator →
 * relayer) under the user's SwapBounds root + the exactInputSingle execution,
 * plus a bounded fee leg off the gas-fee budget. `req` is any 402 (carries the
 * facilitator's redeemer/feeCollector/fee quote). `recipientOverride` lets the
 * rogue beat craft a swap that pays someone else → SwapBounds rejects it.
 */
export async function buildSwapCommission(params: {
  grant: SwapGrant;
  coordinator: Coordinator;
  req: PaymentRequirements;
  amountIn: bigint;
  authorization?: Eip7702Authorization;
  recipientOverride?: Hex;
}): Promise<BuiltSwap> {
  const { grant, coordinator, req, amountIn } = params;
  if (!req.redeemer) throw new Error("facilitator advertised no redeemer (targetAddress)");
  if (!req.feeCollector) throw new Error("facilitator advertised no feeCollector (oneshot-pl)");

  const redeemer = req.redeemer;
  const rootDelegator = decodeDelegations(grant.context).slice(-1)[0].delegator;

  // An open leaf (coordinator → relayer) under a user-signed root. The binding
  // lives on the root's caveat (ApproveBounds / SwapBounds), so the leaf is open.
  const openLeafChain = async (rootContext: Hex): Promise<Delegation[]> => {
    const rootChain = decodeDelegations(rootContext);
    const root = rootChain[0];
    const unsignedLeaf: Omit<Delegation, "signature"> = {
      delegate: redeemer,
      delegator: coordinator.address,
      authority: hashDelegation(root),
      caveats: [],
      salt: toHex(crypto.getRandomValues(new Uint8Array(32))),
    };
    const sig = await signDelegationWithKey({
      privateKey: coordinator.privateKey,
      delegation: unsignedLeaf,
      delegationManager: grant.delegationManager,
      chainId: config.chainId,
      name: "DelegationManager",
      version: "1",
      allowInsecureUnrestrictedDelegation: true,
    });
    return [{ ...unsignedLeaf, signature: sig }, ...rootChain];
  };

  const swapCalldata = encodeSwapCalldata(grant.bounds, amountIn, params.recipientOverride);

  // The atomic batch: [approve, swap]. The approve grants exactly the router
  // allowance the swap consumes — settled together via 1Shot (gas in USDC, no ETH).
  const [approveChain, swapChain] = await Promise.all([
    openLeafChain(grant.approveContext),
    openLeafChain(grant.context),
  ]);
  const works = [
    {
      chain: approveChain,
      execution: { target: config.usdc, value: "0", data: encodeApproveCalldata(grant.bounds.router, amountIn) },
    },
    {
      chain: swapChain,
      execution: { target: grant.bounds.router, value: "0", data: swapCalldata },
    },
  ];

  const feeIntent = keccak256(toHex(crypto.getRandomValues(new Uint8Array(32))));
  const feeChain = await buildBoundChain({
    grant: grant.feeGrant,
    coordinator,
    redeemer,
    token: config.usdc,
    recipient: req.feeCollector,
    maxAmount: feeCapAtoms(req.feeEstimate),
    intentHash: feeIntent,
  });

  const paymentPayload = {
    x402Version: 2,
    scheme: req.scheme,
    network: req.network,
    payload: {
      delegationManager: grant.delegationManager,
      // Schema-compat top level (the oneshot backend uses `works` below).
      permissionContext: encodeDelegations(swapChain),
      delegator: rootDelegator,
      executionCallData: encodeExecutionCalldata([
        createExecution({ target: grant.bounds.router, value: 0n, callData: swapCalldata }),
      ]),
      ...(params.authorization ? { authorization: params.authorization } : {}),
      oneshot: { paymentToken: config.usdc, works, feeChain },
    },
  };

  return { paymentPayload, amountIn };
}

/**
 * Settle a built swap through the facilitator directly (POST /settle) — there's
 * no seller endpoint for a swap, so we drive the relay backend ourselves.
 * Returns the settlement job; poll fetchJob(jobId) for the on-chain tx +
 * confirmedVia, exactly like a payment.
 */
export async function settleSwap(
  paymentPayload: unknown,
  meta: { correlationId?: string; agent?: string } = {}
): Promise<{ ok: boolean; jobId?: string; transaction?: string | null; error?: string }> {
  try {
    const res = await fetch(`${config.facilitatorUrl}/settle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paymentPayload, meta: { ...meta, service: "trade" } }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      success?: boolean; jobId?: string; transaction?: string | null; error?: string;
    };
    if (!res.ok || body.success === false || !body.jobId) {
      return { ok: false, error: body.error ?? `HTTP ${res.status}` };
    }
    return { ok: true, jobId: body.jobId, transaction: body.transaction ?? null };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// --- token allowlist (dynamic-token swaps) ----------------------------------

export interface TradeToken {
  /** Friendly name for normal users, e.g. "ETH", "Bitcoin", "Staked ETH". */
  name: string;
  /** On-chain token symbol (used for matching + the swap). */
  symbol: string;
  address: Hex;
  /** A short hint the scout reasons over to match the prompt. */
  note: string;
  /** Uniswap v3 pool fee tier for the USDC pair (token-specific — cbETH's deepest
   *  USDC pool is 3000, WETH/cbBTC are 500). Defaults to 500 if unset. */
  fee?: number;
}

// The CURATED set a user can authorise for swaps — a vetted menu of liquid Base
// blue-chips (never arbitrary tokens: resolving a name→address blindly is a rug
// vector). The agent can only ever buy from this set, so it's a real choice.
//
// IMPORTANT: these are Base MAINNET addresses (where they have USDC Uniswap
// liquidity). VERIFY each before the mainnet run. On Base Sepolia they're
// placeholders (no liquidity), so testnet swaps don't settle — the authorisation
// + scout pick are real; the live swap is a mainnet thing. At grant time each is
// quoted; on mainnet an un-quotable token is dropped from the signed set.
// Recognisable to a normal user: ETH, Bitcoin, staked-ETH (the yield pick).
const BASE_TOKENS: TradeToken[] = [
  { name: "ETH",        symbol: "WETH",  address: "0x4200000000000000000000000000000000000006", note: "Ether — the base asset", fee: 500 },
  { name: "Bitcoin",    symbol: "cbBTC", address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", note: "Coinbase wrapped BTC — Bitcoin exposure", fee: 500 },
  // cbETH's deepest USDC pool on Base is the 0.3% (3000) tier, not 0.05% — quoting
  // it at 500 returns nothing and would drop it from the signed set on mainnet.
  { name: "Staked ETH", symbol: "cbETH", address: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", note: "Coinbase staked ETH — earns staking yield", fee: 3000 },
];
const TRADE_TOKENS: Record<number, TradeToken[]> = { 8453: BASE_TOKENS, 84532: BASE_TOKENS };

/** The curated token set the user can authorise for this chain. */
export function tradeAllowlist(): TradeToken[] {
  return TRADE_TOKENS[config.chainId] ?? TRADE_TOKENS[84532];
}

export interface AllowlistEntry {
  token: Hex;
  symbol: string;
  name: string;
  minAmountOut: bigint;
  note: string;
  /** The Uniswap fee tier this token was quoted at — reused for the swap so the
   *  trade hits the same pool the floor was priced against. */
  fee: number;
}

export interface SwapAllowlistGrant {
  context: Hex; // SwapAllowlist root
  approveContext: Hex;
  delegationManager: Hex;
  delegationHash: Hex;
  router: Hex;
  tokenIn: Hex;
  maxAmountIn: bigint;
  recipient: Hex;
  fee: number;
  allowlist: AllowlistEntry[];
  feeGrant: GrantResult;
  expiry: number;
}

/** Pack the SwapAllowlistEnforcer terms:
 *  router · tokenIn · maxIn · recipient · N · [tokenOut · minOut]×N. */
function encodeAllowlistTerms(g: {
  router: Hex; tokenIn: Hex; maxAmountIn: bigint; recipient: Hex; allowlist: AllowlistEntry[];
}): Hex {
  const types: string[] = ["address", "address", "uint128", "address", "uint8"];
  const values: unknown[] = [g.router, g.tokenIn, g.maxAmountIn, g.recipient, g.allowlist.length];
  for (const e of g.allowlist) {
    types.push("address", "uint128");
    values.push(e.token, e.minAmountOut);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return encodePacked(types as any, values as any);
}

/**
 * Grant a SWAP authorisation over a SET of output tokens. The user signs a
 * SwapAllowlist root (the curated set, each with its own slippage floor) + an
 * ApproveBounds root + a fee budget. A scout later picks one token from the set;
 * the Trader swaps into it without the user re-signing.
 */
export async function grantSwapAllowlist(params: {
  walletClient: WalletClient;
  userAddress: Hex;
  coordinator: Coordinator;
  amountIn: bigint;
  slippageBps: number;
  tokens?: TradeToken[];
  fee?: number;
  feeBudgetUsdc?: string;
  expiry?: number;
}): Promise<SwapAllowlistGrant> {
  const { walletClient, userAddress, coordinator, amountIn } = params;
  const tokenIn = config.usdc;
  const router = config.uniswapRouter;
  const fee = params.fee ?? 500;
  const expiry = params.expiry ?? 0;
  const tokens = params.tokens ?? tradeAllowlist();

  // Per-token slippage floor from a live quote (best-effort, in PARALLEL). On
  // mainnet a token with no quote is dropped (never authorise a token we can't
  // floor); on testnet a nominal floor keeps the authorisation + scout pick demoable.
  const quoted = await Promise.all(
    tokens.map(async (t) => {
      // Quote each token at ITS OWN pool fee tier (cbETH is 3000, not 500) —
      // quoting at a single tier would drop tokens whose USDC pool isn't that tier.
      const tFee = t.fee ?? fee;
      const expected = await quoteExpectedOut({ tokenIn, tokenOut: t.address, fee: tFee }, amountIn);
      if (expected && expected > 0n) {
        return { token: t.address, symbol: t.symbol, name: t.name, note: t.note, fee: tFee, minAmountOut: (expected * BigInt(10_000 - params.slippageBps)) / 10_000n };
      }
      if (config.chainId === 8453) return null; // mainnet: drop un-quotable tokens
      return { token: t.address, symbol: t.symbol, name: t.name, note: t.note, fee: tFee, minAmountOut: 1n }; // testnet nominal
    })
  );
  const entries: AllowlistEntry[] = quoted.filter((e): e is AllowlistEntry => e !== null);
  if (entries.length === 0) throw new Error("Couldn't price any allowlisted token — refusing to authorise a blind swap.");

  const head = { router, tokenIn, maxAmountIn: amountIn, recipient: userAddress, allowlist: entries };

  const caveats: { enforcer: Hex; terms: Hex; args: Hex }[] = [
    { enforcer: config.swapAllowlistEnforcer, terms: encodeAllowlistTerms(head), args: "0x" as Hex },
  ];
  const approveCaveats: { enforcer: Hex; terms: Hex; args: Hex }[] = [
    { enforcer: config.approveBoundsEnforcer, terms: encodeApproveTerms(tokenIn, router, amountIn), args: "0x" as Hex },
  ];
  if (expiry > 0) {
    const ts = { enforcer: config.timestampEnforcer, terms: encodePacked(["uint128", "uint128"], [0n, BigInt(expiry)]), args: "0x" as Hex };
    caveats.push(ts);
    approveCaveats.push(ts);
  }

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

  const swapRoot = await signRoot(caveats);
  const approveRoot = await signRoot(approveCaveats);
  const feeGrant = await grantBudget({
    walletClient, userAddress, coordinator, amountUsdc: params.feeBudgetUsdc ?? "0.30", periodDuration: 3600,
  });

  return {
    context: encodeDelegations([swapRoot]),
    approveContext: encodeDelegations([approveRoot]),
    delegationManager: config.delegationManager,
    delegationHash: hashDelegation(swapRoot as Delegation),
    router, tokenIn, maxAmountIn: amountIn, recipient: userAddress, fee,
    allowlist: entries, feeGrant, expiry,
  };
}

/** Build the [approve, swap] 1Shot batch for a chosen allowlist token. */
export async function buildAllowlistSwapCommission(params: {
  grant: SwapAllowlistGrant;
  coordinator: Coordinator;
  req: PaymentRequirements;
  tokenOut: Hex;
  amountIn: bigint;
  authorization?: Eip7702Authorization;
  recipientOverride?: Hex;
  /** Rogue beat: build a swap into an OFF-allowlist token so the enforcer (not
   *  the client) rejects it on-chain (SwapAllow:token-not-allowed). */
  allowOffList?: boolean;
}): Promise<BuiltSwap> {
  const { grant, coordinator, req, tokenOut, amountIn } = params;
  if (!req.redeemer) throw new Error("facilitator advertised no redeemer (targetAddress)");
  if (!req.feeCollector) throw new Error("facilitator advertised no feeCollector (oneshot-pl)");
  const entry = grant.allowlist.find((e) => e.token.toLowerCase() === tokenOut.toLowerCase());
  if (!entry && !params.allowOffList) throw new Error("chosen token is not in the signed allowlist");

  const redeemer = req.redeemer;
  const rootDelegator = decodeDelegations(grant.context).slice(-1)[0].delegator;

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

  // Reuse the swap-calldata encoder via a SwapBounds-shaped view of the chosen leg.
  // Use the CHOSEN token's own fee tier (the one its floor was quoted against), so
  // the swap hits the same pool — falling back to the grant default off-allowlist.
  const bounds: SwapBounds = {
    router: grant.router, tokenIn: grant.tokenIn, tokenOut,
    maxAmountIn: grant.maxAmountIn, minAmountOut: entry?.minAmountOut ?? 1n,
    recipient: grant.recipient, fee: entry?.fee ?? grant.fee,
  };
  const swapCalldata = encodeSwapCalldata(bounds, amountIn, params.recipientOverride);

  const [approveChain, swapChain] = await Promise.all([
    openLeafChain(grant.approveContext),
    openLeafChain(grant.context),
  ]);
  const works = [
    { chain: approveChain, execution: { target: config.usdc, value: "0", data: encodeApproveCalldata(grant.router, amountIn) } },
    { chain: swapChain, execution: { target: grant.router, value: "0", data: swapCalldata } },
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
      permissionContext: encodeDelegations(swapChain),
      delegator: rootDelegator,
      executionCallData: encodeExecutionCalldata([
        createExecution({ target: grant.router, value: 0n, callData: swapCalldata }),
      ]),
      ...(params.authorization ? { authorization: params.authorization } : {}),
      oneshot: { paymentToken: config.usdc, works, feeChain },
    },
  };
  return { paymentPayload, amountIn };
}

/** The Scout: pick the best token from the SIGNED allowlist for the prompt. A
 *  deterministic match (keyword → token note) with a rationale; Venice can refine
 *  it later, but the choice is always constrained to the set the user signed. */
export function scoutToken(prompt: string, allowlist: AllowlistEntry[]): { entry: AllowlistEntry; rationale: string } {
  const p = prompt.toLowerCase();
  const wantsYield = /(yield|stak|apr|apy|earn|interest)/.test(p);
  // Prefer a yield-bearing token when the prompt is about yield; else the base asset.
  const pick =
    (wantsYield && allowlist.find((e) => /stak|yield|cbeth|steth|reth/i.test(e.symbol + e.note))) ||
    allowlist[0];
  const rationale = wantsYield && /stak|yield/i.test(pick.note)
    ? `Prompt asks for yield → ${pick.symbol} (${pick.note}) from your authorised set.`
    : `${pick.symbol} (${pick.note}) — best match in your authorised set.`;
  return { entry: pick, rationale };
}

/** The Venice-powered Scout: real reasoning over the SIGNED set with live data,
 *  falling back to the deterministic pick if Venice is unavailable. The choice is
 *  always constrained to the allowlist — the scout can't reach beyond it. */
export async function veniceScout(
  goal: string,
  allowlist: AllowlistEntry[]
): Promise<{ entry: AllowlistEntry; rationale: string; live: boolean }> {
  try {
    const res = await fetch("/api/scout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal, tokens: allowlist.map((e) => ({ name: e.name, symbol: e.symbol, note: e.note })) }),
    });
    if (res.ok) {
      const j = (await res.json()) as { pick?: { symbol?: string; reason?: string } | null };
      const sym = j.pick?.symbol;
      const entry = sym ? allowlist.find((e) => e.symbol.toLowerCase() === sym.toLowerCase()) : undefined;
      if (entry) {
        return { entry, rationale: j.pick?.reason || `${entry.name} — the Scout's pick from your approved set.`, live: true };
      }
    }
  } catch {
    /* fall through to the deterministic scout */
  }
  const det = scoutToken(goal, allowlist);
  return { entry: det.entry, rationale: det.rationale, live: false };
}

// --- prompt understanding ---------------------------------------------------

/** Does the prompt ask the agent to make a trade / move funds into a position? */
export function isTradeIntent(prompt: string): boolean {
  return /\b(trade|swap|buy|yield|rebalance|deploy|invest|stake|allocate|position|move\s+[\d.]+)\b/i.test(prompt);
}

/** Parse a trade prompt → swap amount (USDC) + slippage + an optional named
 *  target token. Defaults: 20 USDC, 1%. `namedToken` is the raw symbol the user
 *  asked for (UPPERCASED) if any — the caller checks it against the signed set. */
export function parseTradeIntent(prompt: string): {
  amountInUsdc: number;
  slippageBps: number;
  namedToken?: string;
} {
  const p = prompt.toLowerCase();
  const amt = p.match(/\$?\s*(\d+(?:\.\d+)?)\s*(?:usdc|dollars?|\$)/) ?? p.match(/\$\s*(\d+(?:\.\d+)?)/);
  const amountInUsdc = amt ? Math.max(0, Number(amt[1])) : 20;
  const slip = p.match(/(\d+(?:\.\d+)?)\s*%/);
  const slippageBps = slip ? Math.round(Number(slip[1]) * 100) : 100;
  // A token named after into/to/buy/for — skip filler words so "into the best ETH
  // staking yield" stays scout-decided, but "into WETH"/"buy cbETH" is captured.
  const tok = p.match(/\b(?:into|buy|acquire|get)\s+(?:the\s+|some\s+)?([a-z][a-z0-9]{1,9})\b/);
  const STOP = new Set(["the", "best", "my", "a", "an", "it", "one", "staking", "yield",
    "eth", "ethereum", "solana", "usdc", "good", "top", "highest", "position", "token"]);
  const raw = tok?.[1];
  const namedToken = raw && !STOP.has(raw) ? raw.toUpperCase() : undefined;
  return { amountInUsdc: amountInUsdc || 20, slippageBps: slippageBps || 100, namedToken };
}

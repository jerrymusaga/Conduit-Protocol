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
const erc20ApproveAbi = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);

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
  delegationManager: Hex;
  delegationHash: Hex;
  bounds: SwapBounds;
  /** The bounded gas-fee budget root (funds 1Shot's USDC gas recoup). */
  feeGrant: GrantResult;
  expiry: number;
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
  const minAmountOut =
    expected && expected > 0n
      ? (expected * BigInt(10_000 - params.slippageBps)) / 10_000n
      : 1n;
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

  const feeGrant = await grantBudget({
    walletClient,
    userAddress,
    coordinator,
    amountUsdc: params.feeBudgetUsdc ?? "0.30",
    periodDuration: 3600,
  });

  return {
    context: encodeDelegations([signedRoot]),
    delegationManager: config.delegationManager,
    delegationHash: hashDelegation(signedRoot as Delegation),
    bounds,
    feeGrant,
    expiry,
  };
}

/** The USDC.approve(router, amount) the user sends once so Uniswap can pull. */
export function approveRouterCalldata(router: Hex, amount: bigint): Hex {
  return encodeFunctionData({ abi: erc20ApproveAbi, functionName: "approve", args: [router, amount] });
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

  const swapCalldata = encodeSwapCalldata(grant.bounds, amountIn, params.recipientOverride);

  const rootChain = decodeDelegations(grant.context);
  const swapRoot = rootChain[0];
  const rootDelegator = rootChain[rootChain.length - 1].delegator;
  const leafSalt = toHex(crypto.getRandomValues(new Uint8Array(32)));

  const unsignedLeaf: Omit<Delegation, "signature"> = {
    delegate: req.redeemer,
    delegator: coordinator.address,
    authority: hashDelegation(swapRoot),
    caveats: [], // open: the binding lives on the user's SwapBounds root
    salt: leafSalt,
  };
  const leafSig = await signDelegationWithKey({
    privateKey: coordinator.privateKey,
    delegation: unsignedLeaf,
    delegationManager: grant.delegationManager,
    chainId: config.chainId,
    name: "DelegationManager",
    version: "1",
    allowInsecureUnrestrictedDelegation: true,
  });
  const workChain: Delegation[] = [{ ...unsignedLeaf, signature: leafSig }, ...rootChain];

  const workExecution = { target: grant.bounds.router, value: "0", data: swapCalldata };

  const feeIntent = keccak256(toHex(crypto.getRandomValues(new Uint8Array(32))));
  const feeChain = await buildBoundChain({
    grant: grant.feeGrant,
    coordinator,
    redeemer: req.redeemer,
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
      permissionContext: encodeDelegations(workChain),
      delegator: rootDelegator,
      executionCallData: encodeExecutionCalldata([
        createExecution({ target: grant.bounds.router, value: 0n, callData: swapCalldata }),
      ]),
      ...(params.authorization ? { authorization: params.authorization } : {}),
      oneshot: { paymentToken: config.usdc, workChain, workExecution, feeChain },
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

// --- prompt understanding ---------------------------------------------------

/** Does the prompt ask the agent to make a trade / move funds into a position? */
export function isTradeIntent(prompt: string): boolean {
  return /\b(trade|swap|buy|yield|rebalance|deploy|invest|stake|allocate|position|move\s+[\d.]+)\b/i.test(prompt);
}

/** Parse a trade prompt → swap amount (USDC) + slippage. Defaults: 20 USDC, 1%. */
export function parseTradeIntent(prompt: string): { amountInUsdc: number; slippageBps: number } {
  const p = prompt.toLowerCase();
  const amt = p.match(/\$?\s*(\d+(?:\.\d+)?)\s*(?:usdc|dollars?|\$)/) ?? p.match(/\$\s*(\d+(?:\.\d+)?)/);
  const amountInUsdc = amt ? Math.max(0, Number(amt[1])) : 20;
  const slip = p.match(/(\d+(?:\.\d+)?)\s*%/);
  const slippageBps = slip ? Math.round(Number(slip[1]) * 100) : 100;
  return { amountInUsdc: amountInUsdc || 20, slippageBps: slippageBps || 100 };
}

/**
 * The subscription beat — Conduit's recurring, intent-bound payment.
 *
 * Where the one-shot flow ([[lib/grant.ts]] + [[lib/payment.ts]]) binds a SINGLE
 * payment with X402ReceiptEnforcer, this binds a RECURRING one with the
 * X402SubscriptionEnforcer: pay one fixed amount, to one merchant, in one token,
 * at most once per period — forever, until the grant is revoked or expires.
 *
 * Positioning (the "service-bound root" reframe): the USER signs a root
 * delegation whose single caveat IS the subscription. The user's own signature
 * is the guardrail — "pay exactly N USDC to this merchant, once per period, and
 * nothing else." This is what MetaMask's first-party x402 does NOT offer: their
 * "recurring" is a rolling spend cap, not a fixed-price, merchant-bound,
 * once-per-period charge with on-chain double-charge protection.
 *
 * Settlement runs through the same oneshot-pl (1Shot) facilitator, which needs a
 * separate buyer-signed FEE delegation to recoup gas in USDC — the sub-enforcer
 * root can't fund the fee (it only authorizes the exact subscription transfer).
 * So a subscription grant is TWO user roots: the subscription root (the binding)
 * + a tiny bounded gas-fee budget root. Both bounded, both user-approved.
 */
import { signDelegation } from "@metamask/smart-accounts-kit/actions";
import {
  decodeDelegations,
  encodeDelegations,
  hashDelegation,
} from "@metamask/smart-accounts-kit/utils";
import {
  encodeFunctionData,
  encodePacked,
  keccak256,
  parseAbi,
  toHex,
  type Hex,
  type WalletClient,
} from "viem";
import {
  createExecution,
  signDelegation as signDelegationWithKey,
} from "@metamask/smart-accounts-kit";
import { encodeExecutionCalldata } from "@metamask/smart-accounts-kit/utils";
import { config } from "./config";
import { publicClient } from "./chain";
import type { Coordinator, GrantResult } from "./grant";
import { grantBudget, revokeRootDelegation } from "./grant";
import {
  buildBoundChain,
  feeCapAtoms,
  type Delegation,
  type Eip7702Authorization,
} from "./payment";
import type { PaymentRequirements, SubscriptionRequirements } from "./endpoint";

const ROOT_AUTHORITY: Hex = `0x${"f".repeat(64)}` as Hex;
const erc20Abi = parseAbi(["function transfer(address to, uint256 amount)"]);

/** The fully-resolved terms the subscription root is bound to. */
export interface SubscriptionTerms {
  enforcer: Hex;
  subscriptionId: Hex;
  token: Hex;
  /** The merchant (x402 payTo). */
  recipient: Hex;
  /** Exact charge per period (token base units). */
  amountPerPeriod: bigint;
  /** Seconds per period. */
  periodSeconds: number;
}

export interface SubscriptionGrant {
  /** Encoded subscription root chain (single root: user → coordinator). */
  context: Hex;
  delegationManager: Hex;
  /** keccak of the subscription root = the enforcer's period-state key. */
  delegationHash: Hex;
  terms: SubscriptionTerms;
  /** The bounded gas-fee budget root (funds 1Shot's USDC gas recoup). */
  feeGrant: GrantResult;
  amountUsdc: string;
  /** Unix seconds the subscription expires (TimestampEnforcer). 0 = no expiry. */
  expiry: number;
}

/**
 * Pack the 94-byte X402SubscriptionEnforcer terms. Layout (matches the contract
 * and the fork test): subscriptionId(32) ++ token(20) ++ recipient(20) ++
 * amountPerPeriod(uint128=16) ++ periodDuration(uint32=4) ++ reserved(uint16=2).
 */
export function encodeSubscriptionTerms(t: SubscriptionTerms): Hex {
  return encodePacked(
    ["bytes32", "address", "address", "uint128", "uint32", "uint16"],
    [t.subscriptionId, t.token, t.recipient, t.amountPerPeriod, t.periodSeconds, 0]
  );
}

/** Resolve the on-chain subscription terms from a 402 envelope. An optional
 *  `tier` (one of the seller-advertised cadence options) overrides the default
 *  period + amount — that's how a buyer-selected cadence gets bound on-chain. */
export function termsFromRequirements(
  req: PaymentRequirements,
  sub: SubscriptionRequirements,
  tier?: { periodSeconds: number; amountPerPeriod: string }
): SubscriptionTerms {
  return {
    enforcer: sub.enforcer,
    subscriptionId: sub.subscriptionId,
    token: req.asset,
    recipient: req.payTo,
    amountPerPeriod: BigInt(tier?.amountPerPeriod ?? sub.amountPerPeriod),
    periodSeconds: tier?.periodSeconds ?? sub.periodSeconds,
  };
}

/**
 * "Subscribe" — the service-bound root grant the user signs. Opens the wallet's
 * signTypedData prompt twice (Privy embedded → instant): once for the
 * subscription root, once for the small bounded gas-fee budget.
 */
export async function grantSubscription(params: {
  walletClient: WalletClient;
  userAddress: Hex;
  coordinator: Coordinator;
  terms: SubscriptionTerms;
  /** Gas-fee budget cap per period in USDC (string). Defaults to 0.05. */
  feeBudgetUsdc?: string;
  /** Unix seconds the subscription should expire. 0/undefined = no expiry. */
  expiry?: number;
}): Promise<SubscriptionGrant> {
  const { walletClient, userAddress, coordinator, terms } = params;
  const expiry = params.expiry ?? 0;

  const subTerms = encodeSubscriptionTerms(terms);
  const salt = toHex(crypto.getRandomValues(new Uint8Array(32)));

  // Caveats: the subscription binding + (optionally) a TimestampEnforcer that
  // makes the whole recurring authorization expire — so it isn't perpetual.
  // TimestampEnforcer terms = packed(uint128 after, uint128 before); we set
  // before=expiry (after=0), so charges revert "expired-delegation" past it.
  const caveats: { enforcer: Hex; terms: Hex; args: Hex }[] = [
    { enforcer: terms.enforcer, terms: subTerms, args: "0x" as Hex },
  ];
  if (expiry > 0) {
    caveats.push({
      enforcer: config.timestampEnforcer,
      terms: encodePacked(["uint128", "uint128"], [0n, BigInt(expiry)]),
      args: "0x" as Hex,
    });
  }

  const unsignedRoot = {
    delegate: coordinator.address,
    delegator: userAddress,
    authority: ROOT_AUTHORITY,
    caveats,
    salt,
  };

  const signature = await signDelegation(walletClient, {
    delegation: unsignedRoot,
    delegationManager: config.delegationManager,
    chainId: config.chainId,
    name: "DelegationManager",
    version: "1",
  });
  const signedRoot = { ...unsignedRoot, signature };
  const context = encodeDelegations([signedRoot]);
  const delegationHash = hashDelegation(signedRoot as Delegation);

  // Bounded gas-fee budget — a separate small root so 1Shot can recoup gas in
  // USDC. Its period matches the subscription so the allowance tracks usage.
  const feeGrant = await grantBudget({
    walletClient,
    userAddress,
    coordinator,
    amountUsdc: params.feeBudgetUsdc ?? "0.30",
    periodDuration: terms.periodSeconds,
  });

  return {
    context,
    delegationManager: config.delegationManager,
    delegationHash,
    terms,
    feeGrant,
    amountUsdc: (Number(terms.amountPerPeriod) / 1e6).toString(),
    expiry,
  };
}

/**
 * Cancel the subscription — `disableDelegation` on the subscription root (the
 * single root in its context). Shares the revoke path with the one-shot budget
 * (see [[revokeRootDelegation]]): the USER's account sends it directly, since
 * the DelegationManager gates it `onlyDeleGator(delegator)`. Once disabled,
 * every future charge against this root reverts. NB: direct tx → needs gas (ETH).
 */
export async function cancelSubscription(params: {
  walletClient: WalletClient;
  userAddress: Hex;
  grant: SubscriptionGrant;
}): Promise<Hex> {
  return revokeRootDelegation({
    walletClient: params.walletClient,
    userAddress: params.userAddress,
    context: params.grant.context,
    delegationManager: params.grant.delegationManager,
  });
}

export interface BuiltSubscriptionPayment {
  paymentPayload: unknown;
  amount: bigint;
  payTo: Hex;
}

/**
 * Build the x402 payload to charge the subscription this period. Mirrors
 * [[buildOneshotPayment]] but the WORK leg is bound by the subscription enforcer
 * (on the user's root) rather than the receipt enforcer:
 *   - workChain: [openLeaf(coordinator→relayer), subscriptionRoot]
 *   - feeChain:  bounded receipt-enforcer chain rooted in the gas-fee budget.
 * The enforcer's once-per-period guard keys on the subscription ROOT hash
 * (stable across charges), so a second charge in the same period reverts —
 * regardless of the fresh leaf salt.
 */
export async function buildSubscriptionPayment(params: {
  grant: SubscriptionGrant;
  coordinator: Coordinator;
  req: PaymentRequirements;
  authorization?: Eip7702Authorization;
}): Promise<BuiltSubscriptionPayment> {
  const { grant, coordinator, req } = params;
  if (!req.redeemer) throw new Error("402 advertised no redeemer (targetAddress)");
  if (!req.feeCollector) throw new Error("402 advertised no feeCollector (oneshot-pl)");

  const { token, recipient, amountPerPeriod } = grant.terms;

  // ---- WORK leg: open leaf (coordinator → relayer) under the sub-enforcer root.
  const rootChain = decodeDelegations(grant.context);
  const subRoot = rootChain[0];
  const rootDelegator = rootChain[rootChain.length - 1].delegator; // user SA
  const leafSalt = toHex(crypto.getRandomValues(new Uint8Array(32)));

  const unsignedLeaf: Omit<Delegation, "signature"> = {
    delegate: req.redeemer,
    delegator: coordinator.address,
    authority: hashDelegation(subRoot),
    caveats: [], // open: the binding lives on the user's sub-enforcer root
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
  const workChain: Delegation[] = [
    { ...unsignedLeaf, signature: leafSig },
    ...rootChain,
  ];

  const workExecution = {
    target: token,
    value: "0",
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [recipient, amountPerPeriod],
    }),
  };

  // ---- FEE leg: bounded receipt-enforcer chain rooted in the gas-fee budget.
  const feeIntent = keccak256(toHex(crypto.getRandomValues(new Uint8Array(32))));
  const feeChain = await buildBoundChain({
    grant: grant.feeGrant,
    coordinator,
    redeemer: req.redeemer,
    token,
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
      // Schema-compat: the oneshot path uses the structured block below.
      permissionContext: encodeDelegations(workChain),
      delegator: rootDelegator,
      executionCallData: encodeExecutionCalldata([
        createExecution({
          target: token,
          value: 0n,
          callData: encodeFunctionData({
            abi: erc20Abi,
            functionName: "transfer",
            args: [recipient, amountPerPeriod],
          }),
        }),
      ]),
      ...(params.authorization ? { authorization: params.authorization } : {}),
      oneshot: {
        paymentToken: token,
        workChain,
        workExecution,
        feeChain,
      },
    },
  };

  return { paymentPayload, amount: amountPerPeriod, payTo: recipient };
}

// --- period state (the console panel) --------------------------------------

const SUB_STATE_ABI = parseAbi([
  "function subscriptions(address delegationManager, bytes32 delegationHash) view returns (uint256 startDate, uint256 lastChargedPeriod)",
]);

export interface SubscriptionState {
  /** Has it ever been charged? */
  active: boolean;
  /** Timestamp (s) of the first charge, anchoring the schedule. 0 if never. */
  startDate: number;
  /** 1-based index of the last charged period. 0 if never. */
  lastChargedPeriod: number;
  /** The period the current wall-clock falls in (1-based). */
  currentPeriod: number;
  /** Already charged in the current period? → "charge again" would revert. */
  chargedThisPeriod: boolean;
  /** Unix seconds when the next charge becomes allowed. */
  nextChargeAt: number;
  /** Seconds until the next charge is allowed (0 if chargeable now). */
  secondsUntilNextCharge: number;
}

/**
 * Read the enforcer's per-delegation period state and derive the UI view. The
 * state keys on (delegationManager, subscription-root hash) — exactly the
 * contract's `subscriptions` mapping.
 */
export async function readSubscriptionState(
  grant: SubscriptionGrant
): Promise<SubscriptionState> {
  const [startDateBn, lastChargedBn] = await publicClient.readContract({
    address: grant.terms.enforcer,
    abi: SUB_STATE_ABI,
    functionName: "subscriptions",
    args: [grant.delegationManager, grant.delegationHash],
  });

  const period = grant.terms.periodSeconds;
  const startDate = Number(startDateBn);
  const lastChargedPeriod = Number(lastChargedBn);
  const now = Math.floor(Date.now() / 1000);

  if (startDate === 0) {
    // Never charged — the first charge anchors period 1 and always succeeds.
    return {
      active: false,
      startDate: 0,
      lastChargedPeriod: 0,
      currentPeriod: 1,
      chargedThisPeriod: false,
      nextChargeAt: now,
      secondsUntilNextCharge: 0,
    };
  }

  const currentPeriod = Math.floor((now - startDate) / period) + 1;
  const chargedThisPeriod = lastChargedPeriod >= currentPeriod;
  // Period `currentPeriod` spans [startDate + (currentPeriod-1)*period,
  // startDate + currentPeriod*period). Its end is when the next charge unlocks.
  const periodEndsAt = startDate + currentPeriod * period;
  const nextChargeAt = chargedThisPeriod ? periodEndsAt : now;

  return {
    active: true,
    startDate,
    lastChargedPeriod,
    currentPeriod,
    chargedThisPeriod,
    nextChargeAt,
    secondsUntilNextCharge: Math.max(0, nextChargeAt - now),
  };
}

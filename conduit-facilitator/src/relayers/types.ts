import type { Address, Hex } from "viem";

/**
 * A signed EIP-7702 authorization tuple, as produced by the buyer's wallet
 * (viem's `signAuthorization`). The relay backend includes it in the
 * submitted transaction's `authorizationList` so the buyer's EOA is
 * upgraded to a smart account in the same tx that redeems the delegation.
 */
export interface Eip7702Authorization {
  chainId: number;
  address: Address; // the implementation the EOA delegates to
  nonce: number;
  r: Hex;
  s: Hex;
  yParity: 0 | 1;
}

/**
 * What every relay backend receives to submit a redemption. The arrays are
 * the exact arguments to DelegationManager.redeemDelegations. The optional
 * `oneshot` block carries the structured form the 1Shot
 * Permissionless Relayer needs (delegations + executions + the buyer-signed fee
 * delegation), which the dapp supplies when paying via the oneshot-pl backend.
 */
export interface RelaySubmitParams {
  permissionContexts: Hex[];
  modes: Hex[];
  executionCallDatas: Hex[];
  /** Optional EIP-7702 auth to bundle into the same tx (mainnet flow). */
  authorization?: Eip7702Authorization;
  /** Structured payload for the oneshot-pl backend (1Shot JSON-RPC). */
  oneshot?: OneshotSubmit;
}

/** A delegation in 1Shot's structured shape (matches relayer schema). */
export interface OneshotDelegation {
  delegate: Address;
  delegator: Address;
  authority: string;
  caveats: Array<{ enforcer: Address; terms: string; args: string }>;
  salt: string;
  signature: string;
}

export interface OneshotExecution {
  target: Address;
  value: string;
  data: Hex;
}

/** One intent-bound payment leg of an atomic commission: a bound delegation
 *  CHAIN [leaf, …, root] plus the USDC.transfer execution it authorizes. */
export interface OneshotWork {
  chain: OneshotDelegation[];
  execution: OneshotExecution;
}

/**
 * The structured payload the dapp builds for a 1Shot submission:
 *  - work(s): Conduit's intent-bound payment(s) (the seller(s)). Either a single
 *    workChain/workExecution (the looped-payment path) OR a `works` array (the
 *    ATOMIC COMMISSION path — N legs settled in one redeemDelegations batch).
 *  - feeChain: a SEPARATE, buyer-signed loose delegation that pays 1Shot's gas
 *    fee in USDC (the fee execution is built by the backend from the live quote,
 *    so it always matches the relayer's required amount). ONE fee leg covers the
 *    whole batch — N payments, one gas fee.
 * The token + paymentToken let the backend quote + build the fee execution.
 */
export interface OneshotSubmit {
  paymentToken: Address;
  /** Single-work path: the work delegation CHAIN [leaf, …, root] + its execution.
   *  Omitted when `works` is supplied (atomic multi-buy). */
  workChain?: OneshotDelegation[];
  workExecution?: OneshotExecution;
  /** Atomic-commission path: N intent-bound work legs merged into ONE
   *  redeemDelegations batch. All-or-nothing: if any leg trips a caveat (e.g. the
   *  budget cap), the whole batch reverts and no seller is paid. */
  works?: OneshotWork[];
  /** The fee delegation CHAIN [leaf, …, root] (bounded fee payment). */
  feeChain: OneshotDelegation[];
}

export type RelayStatus = "submitted" | "pending" | "confirmed" | "failed";

export interface RelayResult {
  jobId: string;
  status: RelayStatus;
  /** Present once known (async — after the 1Shot task is submitted/confirmed). */
  txHash?: Hex;
  error?: string;
}

/**
 * The relay seam. Conduit ships the 1Shot Permissionless Relayer backend;
 * additional backends can be added without touching the routes.
 */
export interface RelayBackend {
  readonly name: string;
  /**
   * The on-chain address that submits redemptions — i.e. msg.sender at the
   * DelegationManager. Buyers must name this in their delegation's Redeemer
   * caveat. For oneshot-pl it's 1Shot's relayer targetAddress (warmed from
   * relayer_getCapabilities; null until ready).
   */
  readonly redeemer: Address | null;
  /**
   * Where the relayer's gas fee must be paid (oneshot-pl only; null otherwise).
   * The buyer builds a loose fee delegation paying this address in stablecoin.
   */
  readonly feeCollector?: Address | null;
  /**
   * Resolve any async startup state (e.g. oneshot-pl fetching its targetAddress
   * + feeCollector from the relayer) so readers like /supported never see nulls
   * due to a warm-up race. No-op for backends that are ready synchronously.
   */
  ensureReady?(): Promise<void>;
  /**
   * Current live gas-fee estimate in token (USDC) atoms, so the buyer can size
   * the bounded fee delegation to the real quote instead of a hardcoded ceiling.
   * Returns null if the backend can't estimate (e.g. viem-direct). */
  estimateFeeAtoms?(): Promise<bigint | null>;
  submit(params: RelaySubmitParams): Promise<RelayResult>;
}

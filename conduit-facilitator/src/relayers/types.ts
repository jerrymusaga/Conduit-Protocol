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

/**
 * The structured payload the dapp builds for a 1Shot submission:
 *  - workDelegation/workExecution: Conduit's intent-bound payment (the seller).
 *  - feeDelegation: a SEPARATE, buyer-signed loose delegation that pays 1Shot's
 *    gas fee in USDC (the fee execution is built by the backend from the live
 *    quote, so it always matches the relayer's required amount).
 * The token + paymentToken let the backend quote + build the fee execution.
 */
export interface OneshotSubmit {
  paymentToken: Address;
  /** The work delegation CHAIN [leaf, …, root] (intent-bound payment). */
  workChain: OneshotDelegation[];
  workExecution: OneshotExecution;
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
  submit(params: RelaySubmitParams): Promise<RelayResult>;
}

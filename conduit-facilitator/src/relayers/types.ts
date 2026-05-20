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
 * the exact arguments to DelegationManager.redeemDelegations.
 */
export interface RelaySubmitParams {
  permissionContexts: Hex[];
  modes: Hex[];
  executionCallDatas: Hex[];
  /** Optional EIP-7702 auth to bundle into the same tx (mainnet flow). */
  authorization?: Eip7702Authorization;
}

export type RelayStatus = "submitted" | "pending" | "confirmed" | "failed";

export interface RelayResult {
  jobId: string;
  status: RelayStatus;
  /** Present once known (synchronous for viem-direct; async for oneshot-pl). */
  txHash?: Hex;
  error?: string;
}

/**
 * The seam that lets us swap testnet (viem-direct) and mainnet
 * (1Shot Permissionless Relayer) without touching routes. Selected at
 * startup from config.relayBackend.
 */
export interface RelayBackend {
  readonly name: string;
  submit(params: RelaySubmitParams): Promise<RelayResult>;
}

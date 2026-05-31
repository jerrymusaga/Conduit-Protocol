import type { Address, Hex } from "viem";

/**
 * Typed JSON-RPC client for the 1Shot Permissionless Relayer. Pure transport +
 * schemas — no Conduit specifics — so it's testable in isolation against the
 * live relayer. Shapes mirror the public-relayer skill reference (verified live
 * against the .dev relayer on Base Sepolia, 2026-05-31).
 *
 *   testnet  https://relayer.1shotapi.dev/relayers   (Sepolia 11155111, Base Sepolia 84532)
 *   mainnet  https://relayer.1shotapi.com/relayers
 */

export function relayerUrlForChain(chainId: number): string {
  return chainId === 11155111 || chainId === 84532
    ? "https://relayer.1shotapi.dev/relayers"
    : "https://relayer.1shotapi.com/relayers";
}

type JsonRpcResponse<T> =
  | { jsonrpc: "2.0"; id: number | string; result: T }
  | { jsonrpc: "2.0"; id: number | string; error: { code: number; message: string; data?: unknown } };

let rpcId = 1;

export async function relayerRpc<T>(
  url: string,
  method: string,
  params: unknown
): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
  });
  const json = (await res.json()) as JsonRpcResponse<T>;
  if ("error" in json) {
    throw new Error(
      `[1shot ${json.error.code}] ${json.error.message} ${
        json.error.data ? JSON.stringify(json.error.data) : ""
      }`.trim()
    );
  }
  if (!res.ok) throw new Error(`1shot HTTP ${res.status}`);
  return json.result;
}

// --- schemas ---------------------------------------------------------------

export interface RelayerToken {
  address: Address;
  symbol?: string;
  name?: string;
  decimals: number | string;
}

export interface ChainCapabilities {
  feeCollector: Address;
  targetAddress: Address;
  tokens: RelayerToken[];
}

export type GetCapabilitiesResult = Record<string, ChainCapabilities>;

export interface FeeData {
  chainId: string;
  token: { address: Address; decimals: number; symbol?: string; name?: string };
  rate: number;
  minFee: string;
  expiry: number;
  gasPrice: Hex;
  feeCollector: Address;
  targetAddress?: Address;
  /** Signed price-lock; pass verbatim to send7710Transaction.context. */
  context?: string;
}

export interface RelayerDelegation {
  delegate: Address;
  delegator: Address;
  authority: string;
  caveats: Array<{ enforcer: Address; terms: string; args: string }>;
  salt: string;
  signature: string;
}

export interface RelayerExecution {
  target: Address;
  value: string;
  data: Hex;
}

export interface DelegatedTransaction {
  permissionContext: RelayerDelegation[];
  executions: RelayerExecution[];
}

export interface AuthorizationListEntry {
  address: Address;
  chainId: number | string;
  nonce: number | string;
  r: Hex;
  s: Hex;
  yParity: number | string;
}

export interface Send7710Params {
  chainId: string;
  transactions: DelegatedTransaction[];
  authorizationList?: AuthorizationListEntry[];
  context?: string;
  taskId?: Hex;
  destinationUrl?: string;
}

/** getStatus result, discriminated by numeric status. */
export interface StatusResult {
  id: Hex;
  chainId: string;
  createdAt: number;
  status: 100 | 110 | 200 | 400 | 500;
  hash?: Hex;
  receipt?: { transactionHash: Hex; blockNumber: string; gasUsed: string; logs?: unknown[] };
  message?: string;
  data?: unknown;
}

// --- methods ---------------------------------------------------------------

export const getCapabilities = (url: string, chainIds: string[]) =>
  relayerRpc<GetCapabilitiesResult>(url, "relayer_getCapabilities", chainIds);

export const getFeeData = (url: string, chainId: string, token: Address) =>
  relayerRpc<FeeData>(url, "relayer_getFeeData", { chainId, token });

export const send7710Transaction = (url: string, params: Send7710Params) =>
  relayerRpc<Hex>(url, "relayer_send7710Transaction", params);

export const send7710TransactionMultichain = (url: string, params: Send7710Params[]) =>
  relayerRpc<Hex[]>(url, "relayer_send7710TransactionMultichain", params);

export const getStatus = (url: string, id: Hex, logs = true) =>
  relayerRpc<StatusResult>(url, "relayer_getStatus", { id, logs });

/**
 * Fee amount in token atoms, floored at minFee. minFee from the live relayer
 * arrives as a DECIMAL string (e.g. "0.01"), so scale it by token decimals.
 */
export function computeFeeAtoms(fee: FeeData, estimatedGasUsed: bigint): bigint {
  const decimals = fee.token.decimals;
  const nativeFeeWei = BigInt(fee.gasPrice) * estimatedGasUsed;
  // rate: native-wei → token atoms (numeric). Float then ceil; fine for testnet.
  const tokenAtoms = BigInt(Math.ceil(Number(nativeFeeWei) * fee.rate));
  const minFeeAtoms = BigInt(Math.round(Number(fee.minFee) * 10 ** decimals));
  return tokenAtoms < minFeeAtoms ? minFeeAtoms : tokenAtoms;
}

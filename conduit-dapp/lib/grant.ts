/**
 * "Ask cleanly" — the root grant.
 *
 * Replaces the old `requestExecutionPermissions` (MetaMask snap RPC) flow with
 * a direct, manual delegation: the dapp builds the root delegation off-chain
 * and asks the user's wallet to sign it with `signTypedData_v4`. Every wallet
 * supports this (Privy embedded, MetaMask extension, WalletConnect), so the
 * 403 from MM's permissions snap is sidestepped entirely.
 *
 * The delegation:
 *   - delegator:  user's EOA (from Privy via wagmi)
 *   - delegate:   coordinator session EOA (ephemeral, deploy-free ECDSA signer)
 *   - authority:  ROOT_AUTHORITY (this is a top-level delegation)
 *   - caveats:    [ERC20PeriodTransferEnforcer(USDC, periodAmount, periodDuration, startTime)]
 *
 * Caveat terms encoding matches the fork test: packed
 *   token(20) ++ periodAmount(uint256) ++ periodDuration(uint256) ++ startTime(uint256)
 * = 116 bytes.
 *
 * The 7702 authorization (designating the user EOA to EIP7702StatelessDeleGator)
 * is signed in the page via Privy's `useSign7702Authorization` hook and bundled
 * into the first redeem by the facilitator's relayer.
 */
import { signDelegation } from "@metamask/smart-accounts-kit/actions";
import { encodeDelegations } from "@metamask/smart-accounts-kit/utils";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  encodePacked,
  parseUnits,
  toHex,
  type Hex,
  type WalletClient,
} from "viem";
import { config } from "./config";

/** DelegationManager sentinel for "this is a root delegation" (= bytes32(uint256.max)). */
const ROOT_AUTHORITY: Hex = `0x${"f".repeat(64)}` as Hex;

/** Coordinator: an ephemeral in-session EOA that holds the root grant. */
export interface Coordinator {
  address: Hex;
  /** In-memory only — used to ECDSA-sign the redelegation. Never persisted. */
  privateKey: Hex;
}

/** Default budget — the starting values the user can adjust on /demo. */
export const BUDGET = {
  periodAmountUsdc: "0.10",
  periodDuration: 3600, // 1 hour
} as const;

export const PERIOD_OPTIONS = [
  { label: "hour", seconds: 3600 },
  { label: "day", seconds: 86400 },
  { label: "week", seconds: 604800 },
] as const;

export function periodLabel(seconds: number): string {
  return PERIOD_OPTIONS.find((o) => o.seconds === seconds)?.label ?? `${seconds}s`;
}

export function createCoordinatorAccount(): Coordinator {
  const privateKey = generatePrivateKey();
  return { privateKey, address: privateKeyToAccount(privateKey).address };
}

export interface GrantResult {
  /** Encoded delegation chain (single root) — opaque hex for the redemption. */
  context: Hex;
  delegationManager: Hex;
  /** Unix seconds when the grant expires (= startTime + periodDuration). */
  expiry: number;
  /** Period cap in token base units (micro-USDC). */
  periodAmount: bigint;
  periodAmountUsdc: string;
  periodDuration: number;
  periodLabel: string;
}

/**
 * Build + sign the root delegation. Opens the wallet's signTypedData prompt
 * (Privy embedded → instant; MetaMask external → popup). Returns the encoded
 * permission context the coordinator will redelegate against.
 */
export async function grantBudget(params: {
  walletClient: WalletClient;
  userAddress: Hex;
  coordinator: Coordinator;
  amountUsdc?: string;
  periodDuration?: number;
}): Promise<GrantResult> {
  const amountUsdc = params.amountUsdc ?? BUDGET.periodAmountUsdc;
  const periodDuration = params.periodDuration ?? BUDGET.periodDuration;

  const periodAmount = parseUnits(amountUsdc, 6);
  if (periodAmount <= 0n) throw new Error("Budget amount must be greater than 0");

  const startTime = Math.floor(Date.now() / 1000);
  const expiry = startTime + periodDuration;

  // ERC20PeriodTransferEnforcer terms (matches contracts/test fork-test layout):
  //   token(20) ++ periodAmount(uint256) ++ periodDuration(uint256) ++ startTime(uint256)
  const rootTerms = encodePacked(
    ["address", "uint256", "uint256", "uint256"],
    [config.usdc, periodAmount, BigInt(periodDuration), BigInt(startTime)]
  );

  // Fresh random salt so the delegation hash is unique per grant.
  const salt = toHex(crypto.getRandomValues(new Uint8Array(32)));

  const unsignedRoot = {
    delegate: params.coordinator.address,
    delegator: params.userAddress,
    authority: ROOT_AUTHORITY,
    caveats: [
      {
        enforcer: config.erc20PeriodTransferEnforcer,
        terms: rootTerms,
        args: "0x" as Hex,
      },
    ],
    salt,
  };

  // signDelegation (the action) calls walletClient.signTypedData under the
  // hood with the EIP-712 typed data the DelegationManager expects.
  const signature = await signDelegation(params.walletClient, {
    delegation: unsignedRoot,
    delegationManager: config.delegationManager,
    chainId: config.chainId,
    name: "DelegationManager",
    version: "1",
  });

  const signedRoot = { ...unsignedRoot, signature };
  const context = encodeDelegations([signedRoot]);

  return {
    context,
    delegationManager: config.delegationManager,
    expiry,
    periodAmount,
    periodAmountUsdc: amountUsdc,
    periodDuration,
    periodLabel: periodLabel(periodDuration),
  };
}

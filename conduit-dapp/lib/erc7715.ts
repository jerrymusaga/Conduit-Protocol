/**
 * ERC-7715 "ask cleanly" — the first judging-lens beat.
 *
 * A user grants a *coordinator* agent a bounded, revocable, time-limited
 * spending policy: up to N USDC per period, single-use per request. The
 * coordinator is an ephemeral session smart account whose address is named as
 * the permission's `signer`; later it redelegates narrower, intent-bound
 * rights to task agents (handoff step 3).
 *
 * MetaMask handles the EIP-7702 upgrade of the user's EOA → Smart Account as
 * part of approving this grant, so there is no separate authorization to sign.
 */
import {
  Implementation,
  toMetaMaskSmartAccount,
  type MetaMaskSmartAccount,
} from "@metamask/smart-accounts-kit";
import {
  erc7715ProviderActions,
  type RequestExecutionPermissionsReturnType,
} from "@metamask/smart-accounts-kit/actions";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { parseUnits, type WalletClient } from "viem";
import { publicClient } from "./chain";
import { config } from "./config";

/** The shape of a single granted permission, from the toolkit's return type. */
export type Permission =
  NonNullable<RequestExecutionPermissionsReturnType>[number];

/** Default agent budget — the starting values the user can adjust on /demo. */
export const BUDGET = {
  /** Human-readable cap per period, in USDC. */
  periodAmountUsdc: "0.10",
  /** Period length in seconds (cap resets each period). */
  periodDuration: 3600, // 1 hour
} as const;

/** Period choices offered in the dapp. The grant expires after one period. */
export const PERIOD_OPTIONS = [
  { label: "hour", seconds: 3600 },
  { label: "day", seconds: 86400 },
  { label: "week", seconds: 604800 },
] as const;

/** Human label for a period length (falls back to "Ns" for custom values). */
export function periodLabel(seconds: number): string {
  return PERIOD_OPTIONS.find((o) => o.seconds === seconds)?.label ?? `${seconds}s`;
}

/**
 * Create the coordinator session account. An ephemeral key lives only for the
 * browser session — it can never exceed the granted budget, so it's safe to
 * generate fresh each time (matches the canonical gator-7715 pattern).
 */
export async function createCoordinatorAccount(): Promise<MetaMaskSmartAccount> {
  const account = privateKeyToAccount(generatePrivateKey());
  return toMetaMaskSmartAccount({
    client: publicClient,
    implementation: Implementation.Hybrid,
    deployParams: [account.address, [], [], []],
    deploySalt: "0x",
    signer: { account },
  });
}

export interface GrantResult {
  /** The full permission response (kept for the redelegation/redeem step). */
  permission: Permission;
  /** The permission context = the signed root delegation (opaque hex). */
  context: `0x${string}`;
  /** DelegationManager that will redeem this permission. */
  delegationManager: `0x${string}`;
  /** Unix seconds when the grant expires. */
  expiry: number;
  /** Period cap in token base units (micro-USDC). */
  periodAmount: bigint;
  /** Same cap, human-readable (e.g. "0.10"). */
  periodAmountUsdc: string;
  /** Period length in seconds. */
  periodDuration: number;
  /** Human label for the period (e.g. "hour"). */
  periodLabel: string;
}

/**
 * Request the ERC-7715 erc20-token-periodic permission from the user. Opens
 * the MetaMask Advanced Permissions dialog; on approval returns the signed
 * root delegation the coordinator will build on.
 */
export async function grantBudget(params: {
  walletClient: WalletClient;
  chainId: number;
  coordinator: MetaMaskSmartAccount;
  /** Human-readable cap per period, in USDC (default 0.10). */
  amountUsdc?: string;
  /** Period length in seconds; the grant expires after one period (default 1h). */
  periodDuration?: number;
}): Promise<GrantResult> {
  const { walletClient, chainId, coordinator } = params;
  const amountUsdc = params.amountUsdc ?? BUDGET.periodAmountUsdc;
  const periodDuration = params.periodDuration ?? BUDGET.periodDuration;

  const periodAmount = parseUnits(amountUsdc, 6); // USDC has 6 decimals
  if (periodAmount <= 0n) throw new Error("Budget amount must be greater than 0");

  const client = walletClient.extend(erc7715ProviderActions());
  const expiry = Math.floor(Date.now() / 1000) + periodDuration;

  // smart-accounts-kit 1.x request shape: the permission is granted `to` the
  // session account; `isAdjustmentAllowed` lives inside the permission.
  const permissions = await client.requestExecutionPermissions([
    {
      chainId,
      to: coordinator.address,
      expiry,
      permission: {
        type: "erc20-token-periodic",
        // Fixed (not wallet-adjustable) so the boundary the user sees in the
        // dapp/MetaMask exactly equals what's enforced on-chain. The amount and
        // period are chosen in the dapp before granting.
        isAdjustmentAllowed: false,
        data: {
          tokenAddress: config.usdc,
          periodAmount,
          periodDuration,
          justification: `Conduit agent budget — up to ${amountUsdc} USDC per ${periodLabel(
            periodDuration
          )}, single-use per request, revocable.`,
        },
      },
    },
  ]);

  const permission = permissions[0];
  if (!permission) throw new Error("No permission returned from the wallet");

  // 1.x moved delegationManager to the top level of the response (was signerMeta).
  const context = permission.context;
  const delegationManager = permission.delegationManager;
  if (!context || !delegationManager) {
    throw new Error("Grant response missing context or delegationManager");
  }

  return {
    permission,
    context,
    delegationManager,
    expiry,
    periodAmount,
    periodAmountUsdc: amountUsdc,
    periodDuration,
    periodLabel: periodLabel(periodDuration),
  };
}

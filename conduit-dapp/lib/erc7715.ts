/**
 * ERC-7715 grant path — for the MetaMask EXTENSION signer.
 *
 * MetaMask deliberately blocks dapp-initiated raw delegation signatures for its
 * own accounts ("External signature requests cannot sign delegations for internal
 * accounts"). The sanctioned way to create a delegation for a MetaMask Smart
 * Account is the native Advanced-Permissions flow: `wallet_requestExecutionPermissions`
 * (ERC-7715). MetaMask handles the EIP-7702 upgrade AND signs a bounded permission
 * in its own UI.
 *
 * The granted `erc20-token-periodic` permission maps exactly to our budget root
 * (ERC20PeriodTransferEnforcer): a per-period spend cap on USDC, delegated TO the
 * coordinator. We hand the returned permission context back as a normal
 * {@link GrantResult}, so the rest of the pipeline is UNCHANGED — the coordinator
 * still redelegates to the relayer and adds the custom X402Receipt caveat on that
 * leaf (a coordinator-signed delegation, which MetaMask never sees), and 1Shot
 * settles it. Embedded (Privy) / passkey signers keep the manual `grantBudget`.
 */
import { createClient, custom, parseUnits, type Hex, type EIP1193Provider } from "viem";
import { erc7715ProviderActions } from "@metamask/smart-accounts-kit/actions";
import { config } from "./config";
import { activeChain } from "./chain";
import { BUDGET, periodLabel, type Coordinator, type GrantResult } from "./grant";

/**
 * Grant the agent budget via MetaMask Advanced Permissions (ERC-7715). Opens
 * MetaMask's native permission prompt (and the 7702 upgrade if the account isn't
 * a smart account yet). Returns a GrantResult identical in shape to grantBudget.
 */
export async function grantBudgetVia7715(params: {
  /** The MetaMask EIP-1193 provider (Privy external wallet → getEthereumProvider()). */
  provider: EIP1193Provider;
  userAddress: Hex;
  coordinator: Coordinator;
  amountUsdc?: string;
  periodDuration?: number;
  /** When the whole grant expires. Defaults to none. */
  expirySeconds?: number;
}): Promise<GrantResult> {
  const amountUsdc = params.amountUsdc ?? BUDGET.periodAmountUsdc;
  const periodDuration = params.periodDuration ?? BUDGET.periodDuration;
  const periodAmount = parseUnits(amountUsdc, 6);
  if (periodAmount <= 0n) throw new Error("Budget amount must be greater than 0");

  const startTime = Math.floor(Date.now() / 1000);
  const hasExpiry = params.expirySeconds !== undefined && params.expirySeconds > 0;
  const expiry = hasExpiry ? startTime + params.expirySeconds! : 0;

  const client = createClient({
    chain: activeChain,
    transport: custom(params.provider),
  }).extend(erc7715ProviderActions());

  // erc20-token-periodic === our ERC20PeriodTransferEnforcer budget. `to` is the
  // delegate (the ephemeral coordinator). MetaMask signs the root + upgrades 7702.
  const granted = await client.requestExecutionPermissions([
    {
      chainId: config.chainId,
      to: params.coordinator.address,
      from: params.userAddress,
      ...(hasExpiry ? { expiry } : {}),
      permission: {
        type: "erc20-token-periodic",
        isAdjustmentAllowed: false,
        data: {
          periodAmount,
          periodDuration,
          startTime,
          tokenAddress: config.usdc,
          justification: "Conduit agent budget — a bounded, revocable per-period USDC cap.",
        },
      },
    },
  ]);

  const g = granted?.[0];
  if (!g?.context) throw new Error("MetaMask returned no permission context (ERC-7715 grant failed)");

  return {
    context: g.context,
    delegationManager: (g.delegationManager ?? config.delegationManager) as Hex,
    expiry,
    periodAmount,
    periodAmountUsdc: amountUsdc,
    periodDuration,
    periodLabel: periodLabel(periodDuration),
  };
}

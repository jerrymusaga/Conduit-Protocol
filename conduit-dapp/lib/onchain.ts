/**
 * Read-only on-chain helpers that make the demo's claims *visible*: live USDC
 * balances and the decoded events from a settlement tx (so judges see the money
 * move and the real receipt, not just a hash).
 */
import {
  erc20Abi,
  parseAbi,
  parseAbiItem,
  parseEventLogs,
  type Hex,
} from "viem";
import { decodeDelegations, hashDelegation } from "@metamask/smart-accounts-kit/utils";
import { publicClient } from "./chain";
import { config } from "./config";

// --- budget state (the one-shot grant's live period allowance) -------------

const PERIOD_ENFORCER_ABI = parseAbi([
  "function getAvailableAmount(bytes32 delegationHash, address delegationManager, bytes terms) view returns (uint256 availableAmount, bool isNewPeriod, uint256 currentPeriod)",
]);

export interface BudgetState {
  /** Cap per period (base units). */
  periodAmount: bigint;
  /** Tokens still spendable THIS period (the truth, read on-chain). */
  available: bigint;
  /** periodAmount − available, clamped ≥ 0. */
  spent: bigint;
  /** Seconds until the period rolls over and the cap refills. */
  resetInSeconds: number;
  /** No budget left this period. */
  exhausted: boolean;
}

/**
 * Read the TRUE on-chain spend for a one-shot budget grant from the
 * ERC20PeriodTransferEnforcer (cumulative across runs, period-aware) — so the
 * meter + "exhausted this period" guard are exact, not an optimistic client sum.
 */
export async function readBudgetState(grant: {
  context: Hex;
  delegationManager: `0x${string}`;
  periodAmount: bigint;
  periodDuration: number;
}): Promise<BudgetState | null> {
  const chain = decodeDelegations(grant.context) as Array<{
    delegate: Hex; delegator: Hex; authority: Hex;
    caveats: { enforcer: Hex; terms: Hex; args: Hex }[];
    salt: Hex; signature: Hex;
  }>;
  const root = chain[chain.length - 1];
  const caveat = root.caveats.find(
    (c) => c.enforcer.toLowerCase() === config.erc20PeriodTransferEnforcer.toLowerCase()
  );
  if (!caveat) return null;

  const delegationHash = hashDelegation(root);
  const [available] = await publicClient.readContract({
    address: config.erc20PeriodTransferEnforcer,
    abi: PERIOD_ENFORCER_ABI,
    functionName: "getAvailableAmount",
    args: [delegationHash, grant.delegationManager, caveat.terms],
  });

  // startDate = last 32 bytes of the 116-byte packed terms (…token·amount·duration·startDate).
  const startDate = Number(BigInt(`0x${caveat.terms.slice(-64)}`));
  const now = Math.floor(Date.now() / 1000);
  const period = grant.periodDuration;
  const elapsed = now - startDate;
  const idx = elapsed >= 0 ? Math.floor(elapsed / period) : 0;
  const resetInSeconds = Math.max(0, startDate + (idx + 1) * period - now);

  const spent = grant.periodAmount > available ? grant.periodAmount - available : 0n;
  return {
    periodAmount: grant.periodAmount,
    available,
    spent,
    resetInSeconds,
    exhausted: available <= 0n,
  };
}

/** USDC balance (base units) for an address. */
export async function readUsdcBalance(address: Hex): Promise<bigint> {
  return publicClient.readContract({
    address: config.usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address],
  });
}

const X402_INTENT_SETTLED = parseAbiItem(
  "event X402IntentSettled(address indexed delegationManager, address indexed delegator, address indexed recipient, bytes32 intentHash, uint256 amount, address token, bytes32 delegationHash)"
);
const X402_SUBSCRIPTION_CHARGED = parseAbiItem(
  "event X402SubscriptionCharged(address indexed delegationManager, address indexed delegator, address indexed recipient, bytes32 subscriptionId, uint256 amount, address token, uint256 period, bytes32 delegationHash)"
);
const TRANSFER = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)"
);

export interface SettlementEvents {
  status: "success" | "reverted";
  /** Total number of logs the tx emitted. */
  logCount: number;
  /** The USDC Transfer (the payment actually moving). */
  transfer?: { from: Hex; to: Hex; value: bigint };
  /** The X402ReceiptEnforcer receipt — the intent-bound settlement. */
  intentSettled?: {
    recipient: Hex;
    amount: bigint;
    intentHash: Hex;
    token: Hex;
  };
  /** The X402SubscriptionEnforcer receipt — the recurring charge. */
  subscriptionCharged?: {
    recipient: Hex;
    amount: bigint;
    subscriptionId: Hex;
    period: bigint;
    token: Hex;
  };
  /** How many delegations were redeemed (DelegationManager logs = chain hops). */
  redemptions: number;
}

/**
 * Wait for the settlement tx to confirm, then decode the events that prove the
 * full redemption happened: the USDC Transfer, the X402IntentSettled receipt,
 * and the per-hop RedeemedDelegation logs from the DelegationManager.
 */
export async function fetchSettlementEvents(
  txHash: Hex
): Promise<SettlementEvents> {
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  const logs = receipt.logs;

  const transfers = parseEventLogs({ abi: [TRANSFER], logs, eventName: "Transfer" });
  const intents = parseEventLogs({
    abi: [X402_INTENT_SETTLED],
    logs,
    eventName: "X402IntentSettled",
  });
  const subs = parseEventLogs({
    abi: [X402_SUBSCRIPTION_CHARGED],
    logs,
    eventName: "X402SubscriptionCharged",
  });

  const usdc = config.usdc.toLowerCase();
  const transfer = transfers.find((t) => t.address.toLowerCase() === usdc);
  const intent = intents[0];
  const sub = subs[0];

  const dm = config.delegationManager.toLowerCase();
  const redemptions = logs.filter((l) => l.address.toLowerCase() === dm).length;

  return {
    status: receipt.status,
    logCount: logs.length,
    transfer: transfer
      ? { from: transfer.args.from, to: transfer.args.to, value: transfer.args.value }
      : undefined,
    intentSettled: intent
      ? {
          recipient: intent.args.recipient,
          amount: intent.args.amount,
          intentHash: intent.args.intentHash,
          token: intent.args.token,
        }
      : undefined,
    subscriptionCharged: sub
      ? {
          recipient: sub.args.recipient,
          amount: sub.args.amount,
          subscriptionId: sub.args.subscriptionId,
          period: sub.args.period,
          token: sub.args.token,
        }
      : undefined,
    redemptions,
  };
}

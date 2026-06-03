"use client";

/**
 * The ERC-7710 inspector — makes the delegation redemption VISIBLE.
 *
 * Each payment in the Conduit console is an ERC-7710 delegation redeemed
 * through MetaMask's DelegationManager, bounded by a Conduit caveat. This panel
 * surfaces that anatomy so a dev (or judge) can SEE the 7710 call, not just a
 * green checkmark:
 *   - which Conduit caveat bound the payment (+ its terms),
 *   - the redeemDelegations() call into MetaMask's DelegationManager,
 *   - and, once settled, the decoded on-chain proof (per-hop RedeemedDelegation
 *     logs, the enforcer's receipt event, the USDC Transfer) — tx-linked.
 */
import { useEffect, useState } from "react";
import { formatUnits, type Hex } from "viem";
import { config } from "@/lib/config";
import { fetchSettlementEvents, type SettlementEvents } from "@/lib/onchain";

export interface InspectorBinding {
  /** Human enforcer name, e.g. "X402SubscriptionEnforcer". */
  enforcerName: string;
  /** Enforcer contract address. */
  enforcerAddr: string;
  /** One-line summary of what the caveat bound, e.g. "0.01 USDC → 0x12…ab · 1×/60s". */
  boundSummary: string;
}

function short(addr?: string | null): string {
  if (!addr) return "—";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function Erc7710Inspector({
  binding,
  txHash,
}: {
  binding: InspectorBinding;
  txHash?: string | null;
}) {
  const [events, setEvents] = useState<SettlementEvents | null>(null);
  const [loading, setLoading] = useState(false);

  const hasTx = !!txHash && txHash.startsWith("0x");

  useEffect(() => {
    if (!hasTx) return;
    let cancelled = false;
    setLoading(true);
    fetchSettlementEvents(txHash as Hex)
      .then((e) => !cancelled && setEvents(e))
      .catch(() => {})
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [txHash, hasTx]);

  const receipt = events?.subscriptionCharged ?? events?.intentSettled;

  return (
    <div className="mono mt-3 rounded-lg border border-conduit-border/50 bg-black/30 p-3 text-[11px]">
      <p className="mb-2 uppercase tracking-wide text-conduit-muted/60">ERC-7710 redemption</p>

      <Line k="bound by" v={binding.enforcerName} link={`${config.explorerUrl}/address/${binding.enforcerAddr}`} linkLabel={short(binding.enforcerAddr)} />
      <Line k="terms" v={binding.boundSummary} />
      <Line
        k="redeemed via"
        v="redeemDelegations()"
        link={`${config.explorerUrl}/address/${config.delegationManager}`}
        linkLabel={`MetaMask DelegationManager ${short(config.delegationManager)}`}
      />

      {hasTx && (
        <>
          <div className="my-2.5 border-t border-conduit-border/40" />
          <p className="mb-1.5 uppercase tracking-wide text-conduit-muted/60">on-chain proof</p>
          {loading && !events && <p className="text-conduit-muted">decoding settlement tx…</p>}
          {events && (
            <>
              <Line k="delegation hops" v={`${events.redemptions} redeemed (chain depth)`} />
              {events.subscriptionCharged && (
                <Line k="caveat fired" v={`X402SubscriptionCharged · period #${events.subscriptionCharged.period.toString()}`} tone="ok" />
              )}
              {events.intentSettled && !events.subscriptionCharged && (
                <Line k="caveat fired" v="X402IntentSettled" tone="ok" />
              )}
              {receipt && (
                <Line k="paid" v={`${formatUnits(receipt.amount, 6)} USDC → ${short(receipt.recipient)}`} />
              )}
              {events.transfer && (
                <Line k="USDC Transfer" v={`${formatUnits(events.transfer.value, 6)} → ${short(events.transfer.to)}`} />
              )}
              <Line
                k="settlement tx"
                v={short(txHash)}
                link={`${config.explorerUrl}/tx/${txHash}`}
                linkLabel="view ↗"
              />
            </>
          )}
        </>
      )}
    </div>
  );
}

function Line({
  k,
  v,
  link,
  linkLabel,
  tone,
}: {
  k: string;
  v: string;
  link?: string;
  linkLabel?: string;
  tone?: "ok";
}) {
  return (
    <div className="flex items-start justify-between gap-3 py-0.5">
      <span className="shrink-0 text-conduit-muted/60">{k}</span>
      <span className={`text-right ${tone === "ok" ? "text-conduit-cyan" : "text-white"}`}>
        {v}
        {link && (
          <>
            {" "}
            <a
              href={link}
              target="_blank"
              rel="noopener noreferrer"
              className="text-conduit-cyan underline-offset-4 hover:underline"
            >
              {linkLabel ?? "↗"}
            </a>
          </>
        )}
      </span>
    </div>
  );
}

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

/** The Conduit (and built-in) caveat families a binding can describe. Drives the
 *  plain-language explainer + the "physically prevents" list, so the inspector is
 *  consistent and educational across the whole app, not just one enforcer. */
export type EnforcerKind =
  | "receipt"
  | "subscription"
  | "budget"
  | "swap"
  | "yield"
  | "timestamp"
  | "id";

export interface CaveatField {
  label: string;
  value: string;
}

export interface InspectorBinding {
  /** Which caveat family — selects the explainer + guarantees. */
  kind: EnforcerKind;
  /** Human enforcer name, e.g. "X402SubscriptionEnforcer". */
  enforcerName: string;
  /** Enforcer contract address. */
  enforcerAddr: string;
  /** Decoded bound terms as labeled rows — what the caveat pins on-chain. */
  terms?: CaveatField[];
  /** Back-compat one-line summary, used when `terms` is omitted. */
  boundSummary?: string;
  /** This redemption tried to BREAK the caveat (the rogue beat) → reframe. */
  violated?: boolean;
}

/** Single source of truth for what each caveat does and what it makes impossible.
 *  Exported so any surface can explain a caveat the same way. */
export const ENFORCER_INFO: Record<EnforcerKind, { label: string; what: string; prevents: string[] }> = {
  receipt: {
    label: "Intent-bound payment",
    what: "Binds one payment to a single x402 request — exact token, recipient, and a max amount.",
    prevents: ["paying anyone but the bound recipient", "paying more than the cap", "reusing the payment (one-shot)"],
  },
  subscription: {
    label: "Recurring charge",
    what: "Permits exactly one charge per period, to a fixed merchant, for a fixed amount.",
    prevents: ["a second charge in the same period", "changing the amount or merchant", "charging after you revoke"],
  },
  budget: {
    label: "Spend budget",
    what: "A rolling per-period spend cap on one token — the agent's whole allowance.",
    prevents: ["spending past the cap in a period", "spending a different token", "out-living the expiry"],
  },
  swap: {
    label: "Bounded swap",
    what: "Bounds one DEX swap — fixed pair, max input, a slippage floor, proceeds to you.",
    prevents: ["swapping to a different token", "overspending the input cap", "accepting a worse fill than the floor", "redirecting the proceeds"],
  },
  yield: {
    label: "Bounded yield deposit",
    what: "Bounds one lending-pool deposit — a signed set of venues, one asset, a max amount, position credited to you.",
    prevents: ["supplying into a venue you didn't approve", "overspending the cap", "supplying a different asset", "redirecting the position"],
  },
  timestamp: {
    label: "Validity window",
    what: "Limits when the delegation can be used (an expiry window).",
    prevents: ["any use after it expires"],
  },
  id: {
    label: "Replay guard",
    what: "One-shot replay protection — the delegation is redeemable exactly once.",
    prevents: ["replaying an already-used redemption"],
  },
};

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
  const info = ENFORCER_INFO[binding.kind];

  return (
    <div className="mono mt-3 rounded-lg border border-conduit-border/50 bg-black/30 p-3 text-[11px]">
      <p className="mb-2 uppercase tracking-wide text-conduit-muted/60">ERC-7710 caveat</p>

      <Line
        k="bound by"
        v={binding.enforcerName}
        link={`${config.explorerUrl}/address/${binding.enforcerAddr}`}
        linkLabel={short(binding.enforcerAddr)}
      />
      {/* Plain-language explainer — what this kind of caveat does. */}
      <p className="mt-1.5 text-conduit-muted">{info.what}</p>

      {/* Decoded bound terms — what THIS caveat pins on-chain. */}
      <div className="my-2 border-t border-conduit-border/40" />
      {binding.terms && binding.terms.length > 0 ? (
        binding.terms.map((t) => <Line key={t.label} k={t.label} v={t.value} />)
      ) : (
        <Line k="terms" v={binding.boundSummary ?? "—"} />
      )}

      {/* What it makes physically impossible — the safety property, in words. */}
      <div className="my-2 border-t border-conduit-border/40" />
      <p className="mb-1 uppercase tracking-wide text-conduit-muted/60">
        {binding.violated ? "this redemption tried to" : "the agent physically can't"}
      </p>
      <ul className="space-y-0.5">
        {info.prevents.map((p) => (
          <li key={p} className={binding.violated ? "text-conduit-magenta" : "text-conduit-muted"}>
            <span className={binding.violated ? "text-conduit-magenta" : "text-conduit-cyan"}>
              {binding.violated ? "✗" : "✓"}
            </span>{" "}
            {p}
          </li>
        ))}
      </ul>
      {binding.violated && (
        <p className="mt-1 text-conduit-magenta">→ rejected on-chain before any funds moved.</p>
      )}

      <div className="my-2 border-t border-conduit-border/40" />
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

"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAccount, useWalletClient } from "wagmi";
import { useActiveWallet } from "@/lib/activeWallet";
import { useConduitEmbedded } from "@/lib/conduitEmbedded";
import {
  usePrivy,
  useLogin,
  useWallets,
  getEmbeddedConnectedWallet,
} from "@privy-io/react-auth";
import { useSetActiveWallet } from "@privy-io/wagmi";
import { formatUnits, type Hex } from "viem";
import { config } from "@/lib/config";
import { publicClient } from "@/lib/chain";
import { useFacilitatorEvents } from "@/lib/useFacilitatorEvents";
import { listGrants, markGrantRevoked, type GrantRecord } from "@/lib/grants";
import { gaslessRevoke } from "@/lib/revoke";
import { readBudgetState, type BudgetState } from "@/lib/onchain";
import { readSubscriptionState, type SubscriptionGrant, type SubscriptionState } from "@/lib/subscription";
import { Erc7710Inspector, type InspectorBinding } from "@/components/Erc7710Inspector";

/* ===========================================================================
   Conduit — the PORTFOLIO. One place a wallet sees and manages every agent
   permission it has granted (budgets from /demo, subscriptions from
   /subscription). ERC-7715 grants are signed off-chain (no "created" event),
   so the facilitator's grants registry is the per-wallet index; LIVE state
   (budget left, period, status) is read fresh on-chain here.
   =========================================================================== */

type Status = "active" | "exhausted" | "expired" | "revoked";

interface LiveState {
  budget?: BudgetState | null;
  sub?: SubscriptionState | null;
}

const shorten = (a?: string | null) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");
const now = () => Math.floor(Date.now() / 1000);

function fmtDur(sec: number): string {
  if (sec <= 0) return "0s";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

function statusOf(g: GrantRecord, live: LiveState | undefined): Status {
  if (g.revokedAt) return "revoked";
  if (g.expiry && g.expiry > 0 && now() >= g.expiry) return "expired";
  if (g.kind === "budget" && live?.budget?.exhausted) return "exhausted";
  return "active";
}

const STATUS_STYLE: Record<Status, { cls: string; label: string }> = {
  active: { cls: "bg-conduit-cyan/15 text-conduit-cyan", label: "active" },
  exhausted: { cls: "bg-conduit-violet/15 text-conduit-violet", label: "budget spent" },
  expired: { cls: "border border-conduit-border text-conduit-muted", label: "expired" },
  revoked: { cls: "bg-conduit-magenta/15 text-conduit-magenta", label: "revoked" },
};

export default function PortfolioPage() {
  const { ready, authenticated, logout } = usePrivy();
  const { login } = useLogin();
  const { wallets } = useWallets();
  const { setActiveWallet } = useSetActiveWallet();
  const { address: wagmiAddress, isConnected: wagmiConnected } = useAccount();
  const { data: wagmiWalletClient } = useWalletClient({ chainId: config.chainId });

  // ConduitPay: passkey wallet when signed in that way via the shell, else the
  // wagmi-bound (Privy) wallet — privy behavior unchanged.
  const activeWallet = useActiveWallet();
  const inShell = useConduitEmbedded();
  const isPasskey = activeWallet.provider === "passkey";
  const address = isPasskey ? activeWallet.address : wagmiAddress;
  const isConnected = isPasskey ? activeWallet.isConnected : wagmiConnected;
  const walletClient = isPasskey ? activeWallet.walletClient : wagmiWalletClient;
  const connected = isPasskey
    ? activeWallet.isConnected && !!activeWallet.address
    : ready && authenticated && isConnected && !!address;

  const [grants, setGrants] = useState<GrantRecord[]>([]);
  const [live, setLive] = useState<Record<string, LiveState>>({});
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [nowSec, setNowSec] = useState(now());
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!authenticated || wallets.length === 0) return;
    const embedded = getEmbeddedConnectedWallet(wallets);
    const ethExternal = wallets.find((w) => w.chainId?.startsWith("eip155:"));
    const target = embedded ?? ethExternal ?? wallets[0];
    if (!target) return;
    if (address && address.toLowerCase() === target.address.toLowerCase()) return;
    void setActiveWallet(target);
  }, [authenticated, wallets, address, setActiveWallet]);

  // 1s tick for the countdowns.
  useEffect(() => {
    const id = setInterval(() => setNowSec(now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Read live on-chain state for one grant.
  const readLive = useCallback(async (g: GrantRecord): Promise<LiveState> => {
    try {
      if (g.kind === "budget" && g.context && g.amount && g.periodSeconds) {
        const budget = await readBudgetState({
          context: g.context as Hex,
          delegationManager: config.delegationManager,
          periodAmount: BigInt(g.amount),
          periodDuration: g.periodSeconds,
        });
        return { budget };
      }
      if (g.kind === "subscription" && g.delegationHash && g.enforcer && g.periodSeconds) {
        // readSubscriptionState only needs terms.enforcer/periodSeconds +
        // delegationManager + delegationHash — reconstruct a minimal grant.
        const partial = {
          delegationManager: config.delegationManager,
          delegationHash: g.delegationHash as Hex,
          terms: { enforcer: g.enforcer as Hex, periodSeconds: g.periodSeconds },
        } as unknown as SubscriptionGrant;
        const sub = await readSubscriptionState(partial);
        return { sub };
      }
    } catch {
      /* transient RPC error — show the grant without live state */
    }
    return {};
  }, []);

  const refresh = useCallback(async () => {
    if (!address) return;
    setLoading(true);
    try {
      const list = await listGrants(address);
      setGrants(list);
      const entries = await Promise.all(list.map(async (g) => [g.id, await readLive(g)] as const));
      setLive(Object.fromEntries(entries));
    } finally {
      setLoading(false);
    }
  }, [address, readLive]);

  // Live touch: subscribe to the facilitator's SSE feed (driven by 1Shot's signed
  // settlement webhooks). When a settlement confirms, re-read on-chain grant state
  // so the portfolio reflects the new spend/period immediately — the webhook is the
  // trigger, the chain is still the source of truth.
  const { events, connected: liveConnected } = useFacilitatorEvents(connected);
  const seenSettled = useRef(new Set<string>());
  useEffect(() => {
    const fresh = events.filter((e) => e.stage === "settled" && !seenSettled.current.has(e.id));
    if (fresh.length === 0) return;
    fresh.forEach((e) => seenSettled.current.add(e.id));
    void refresh();
  }, [events, refresh]);

  useEffect(() => {
    if (connected) void refresh();
    else {
      setGrants([]);
      setLive({});
    }
  }, [connected, refresh]);

  const revoke = async (g: GrantRecord) => {
    if (!walletClient || !address || !g.context) return;
    setBusyId(g.id);
    setNote(null);
    // Gasless (relayer disables the root, gas in USDC) with a direct-tx fallback.
    const r = await gaslessRevoke({
      walletClient,
      userAddress: address as Hex,
      context: g.context as Hex,
      delegationManager: config.delegationManager,
      signAuthorization: activeWallet.signAuthorization,
      log: setNote,
    });
    if (r.ok) {
      await markGrantRevoked(g.id, address);
      setGrants((gs) => gs.map((x) => (x.id === g.id ? { ...x, revokedAt: Date.now() } : x)));
      setNote(`Revoked ${r.viaGasless ? "gaslessly" : "on-chain"} ✓ · ${shorten(r.tx ?? "")} — every charge against this permission now reverts.`);
    } else {
      setNote(`Revoke failed · ${r.error}`);
    }
    setBusyId(null);
  };

  const active = grants.filter((g) => statusOf(g, live[g.id]) === "active").length;

  return (
    <main className="min-h-screen">
      {/* top bar — standalone only; the ConduitPay shell provides the header */}
      {!inShell && (
      <div className="border-b border-conduit-border/60">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link href="/" className="flex items-center gap-2.5">
            <Image src="/images/conduit-logo.png" alt="Conduit" width={28} height={28} className="h-7 w-7" />
            <span className="font-semibold tracking-tight">Conduit</span>
            <span className="mono ml-2 rounded-md border border-conduit-border px-2 py-0.5 text-[11px] text-conduit-muted">
              portfolio
            </span>
          </Link>
          <div className="flex items-center gap-3 text-xs">
            <Link href="/demo" className="text-conduit-muted underline-offset-4 hover:text-white hover:underline">one-shot</Link>
            <Link href="/subscription" className="text-conduit-muted underline-offset-4 hover:text-white hover:underline">subscriptions</Link>
            {connected ? (
              <button onClick={() => void logout()} className="text-conduit-muted underline-offset-4 hover:text-white hover:underline">
                {shorten(address)} · sign out
              </button>
            ) : (
              <button onClick={() => login()} disabled={!ready} className="btn-primary text-sm disabled:opacity-40">
                {ready ? "Sign in" : "Loading…"}
              </button>
            )}
          </div>
        </div>
      </div>
      )}

      <div className="mx-auto max-w-6xl px-6 py-8">
        {/* header */}
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="text-xl font-semibold tracking-tight text-white">Your agent permissions</h1>
              <span className="mono flex items-center gap-1.5 text-[11px] text-conduit-muted" title="Settlements stream in from 1Shot's signed webhooks via the facilitator">
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: liveConnected ? "#00E5FF" : "#666" }} />
                {liveConnected ? "live" : "connecting"}
              </span>
            </div>
            <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-conduit-muted">
              Every budget and subscription this wallet has granted, with live on-chain state.
              Each one is bounded and revocable — your kill switch is one tx away.
            </p>
          </div>
          {connected && (
            <button
              onClick={() => void refresh()}
              disabled={loading}
              className="mono rounded-md border border-conduit-border px-3 py-1.5 text-[12px] text-conduit-muted transition-colors hover:border-conduit-cyan/50 hover:text-conduit-cyan disabled:opacity-40"
            >
              {loading ? "refreshing…" : "↻ refresh"}
            </button>
          )}
        </div>

        {note && (
          <p className="mono mt-4 rounded-lg border border-conduit-border bg-conduit-panel/50 px-3 py-2 text-[12px] text-conduit-muted">
            {note}
          </p>
        )}

        {/* summary */}
        {connected && grants.length > 0 && (
          <div className="mono mt-5 flex flex-wrap gap-x-6 gap-y-1 text-[12px] text-conduit-muted">
            <span><span className="text-white">{grants.length}</span> total</span>
            <span><span className="text-conduit-cyan">{active}</span> active</span>
            <span><span className="text-white">{grants.filter((g) => g.kind === "budget").length}</span> budgets</span>
            <span><span className="text-white">{grants.filter((g) => g.kind === "subscription").length}</span> subscriptions</span>
            <span><span className="text-white">{grants.filter((g) => g.kind === "swap").length}</span> swaps</span>
          </div>
        )}

        {/* body */}
        <div className="mt-6 space-y-4">
          {!connected ? (
            <div className="panel p-10 text-center">
              <p className="text-sm text-conduit-muted">Sign in to see the permissions this wallet has granted.</p>
            </div>
          ) : loading && grants.length === 0 ? (
            <div className="panel p-10 text-center">
              <p className="mono text-sm text-conduit-muted">Loading your permissions…</p>
            </div>
          ) : grants.length === 0 ? (
            <div className="panel p-10 text-center">
              <p className="text-sm text-conduit-muted">No permissions yet.</p>
              <p className="mt-2 text-[12px] text-conduit-muted/70">
                Grant an agent budget on the <Link href="/demo" className="text-conduit-cyan hover:underline">one-shot console</Link>,
                or start a <Link href="/subscription" className="text-conduit-cyan hover:underline">subscription</Link>.
              </p>
            </div>
          ) : (
            grants.map((g) => (
              <GrantCard
                key={g.id}
                g={g}
                live={live[g.id]}
                status={statusOf(g, live[g.id])}
                nowSec={nowSec}
                busy={busyId === g.id}
                inShell={inShell}
                onRevoke={() => void revoke(g)}
              />
            ))
          )}
        </div>
      </div>
    </main>
  );
}

function GrantCard({
  g, live, status, nowSec, busy, inShell, onRevoke,
}: {
  g: GrantRecord;
  live: LiveState | undefined;
  status: Status;
  nowSec: number;
  busy: boolean;
  inShell: boolean;
  onRevoke: () => void;
}) {
  const [showCaveat, setShowCaveat] = useState(false);
  const s = STATUS_STYLE[status];
  const isSub = g.kind === "subscription";
  const isSwap = g.kind === "swap";
  const isYield = g.kind === "yield";
  const amountUsdc = g.amount ? formatUnits(BigInt(g.amount), 6) : "—";
  const expiryText = !g.expiry || g.expiry === 0 ? "no expiry" : nowSec >= g.expiry ? "expired" : `in ${fmtDur(g.expiry - nowSec)}`;
  const canRevoke = status === "active" && !!g.context;

  const kindChip = isSub
    ? { cls: "bg-conduit-violet/15 text-conduit-violet", text: "subscription" }
    : isSwap
      ? { cls: "bg-conduit-magenta/15 text-conduit-magenta", text: "swap" }
      : isYield
        ? { cls: "bg-conduit-cyan/15 text-conduit-cyan", text: "yield" }
        : { cls: "bg-conduit-cyan/10 text-conduit-cyan", text: "budget" };

  // The exact on-chain caveat this permission carries — what it actually permits.
  const binding: InspectorBinding | null = g.enforcer
    ? {
        kind: g.kind,
        enforcerName: isSub ? "X402SubscriptionEnforcer" : isSwap ? "SwapBoundsEnforcer" : isYield ? "YieldAllowlistEnforcer" : "ERC20PeriodTransferEnforcer",
        enforcerAddr: g.enforcer,
        terms: isSub
          ? [
              { label: "amount", value: `${amountUsdc} USDC (exact)` },
              { label: "merchant", value: shorten(g.merchant) },
              { label: "cadence", value: `1×/${fmtDur(g.periodSeconds ?? 0)}` },
            ]
          : isYield
            ? [
                { label: "max in", value: `${amountUsdc} USDC` },
                { label: "into", value: "your approved venues" },
                { label: "position", value: "credited to you" },
                { label: "expires", value: expiryText },
              ]
          : isSwap
            ? [
                { label: "max in", value: `${amountUsdc} USDC` },
                { label: "out", value: "WETH" },
                { label: "slippage", value: "≤ 1%" },
                { label: "to", value: "your account" },
              ]
            : [
                { label: "cap", value: `≤ ${amountUsdc} USDC / ${fmtDur(g.periodSeconds ?? 0)}` },
                { label: "agent", value: shorten(g.coordinator) },
                { label: "expires", value: expiryText },
              ],
      }
    : null;

  return (
    <section className="panel p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className={`mono rounded px-1.5 py-0.5 text-[10px] ${kindChip.cls}`}>{kindChip.text}</span>
          <h3 className="text-sm font-semibold text-white">{g.label || (isSub ? "Subscription" : isSwap ? "Bounded swap" : "Agent budget")}</h3>
        </div>
        <span className={`mono rounded-md px-2 py-0.5 text-[11px] ${s.cls}`}>{s.label}</span>
      </div>

      {/* the prompt this permission was authorised for */}
      {g.prompt && (
        <p className="mt-1.5 text-[12px] leading-relaxed text-conduit-muted">
          <span className="text-conduit-muted/60">for:</span> &ldquo;{g.prompt}&rdquo;
        </p>
      )}

      {/* live state */}
      {isSub ? (
        <SubMeter g={g} sub={live?.sub} amountUsdc={amountUsdc} nowSec={nowSec} status={status} />
      ) : isSwap ? (
        <p className="mt-3 text-[12px] text-conduit-muted">
          {status === "active"
            ? `Authorises one bounded swap · ≤ ${amountUsdc} USDC → WETH, slippage floor + recipient pinned in your signature.`
            : "This swap authorisation can no longer be used."}
        </p>
      ) : (
        <BudgetMeter budget={live?.budget} amountUsdc={amountUsdc} status={status} />
      )}

      {/* facts */}
      <div className="mono mt-4 grid grid-cols-2 gap-x-6 gap-y-1 text-[12px] sm:grid-cols-3">
        <Fact k={isSub ? "per charge" : isSwap ? "max in" : "budget"} v={`${amountUsdc} USDC`} />
        {isSub && <Fact k="cadence" v={`every ${fmtDur(g.periodSeconds ?? 0)}`} />}
        {isSwap && <Fact k="buys" v="WETH" />}
        <Fact k="expires" v={expiryText} />
        {isSub && g.merchant && <Fact k="paid to" v={shorten(g.merchant)} />}
        {g.coordinator && <Fact k="agent" v={shorten(g.coordinator)} />}
        <Fact k="granted" v={new Date(g.createdAt).toLocaleDateString()} />
      </div>

      {/* what this permission actually permits — the on-chain caveat */}
      {binding && (
        <>
          <button
            onClick={() => setShowCaveat((o) => !o)}
            className="mono mt-3 text-[11px] text-conduit-muted underline-offset-4 hover:text-conduit-cyan"
          >
            {showCaveat ? "▾ hide caveat" : "▸ inspect caveat"}
          </button>
          {showCaveat && <Erc7710Inspector binding={binding} />}
        </>
      )}

      {/* actions */}
      <div className="mt-4 flex items-center gap-3">
        <Link
          href={inShell ? (isSub ? "/app/subscriptions" : "/app/pay") : isSub ? "/subscription" : "/demo"}
          className="mono text-[12px] text-conduit-muted underline-offset-4 hover:text-conduit-cyan hover:underline"
        >
          open {isSub ? "subscriptions" : "console"} ↗
        </Link>
        {canRevoke && (
          <button
            onClick={onRevoke}
            disabled={busy}
            className="ml-auto rounded-lg border border-conduit-magenta/40 px-3 py-1.5 text-[12px] font-medium text-conduit-magenta transition-colors hover:bg-conduit-magenta/10 disabled:opacity-40"
          >
            {busy ? "Revoking…" : "Revoke on-chain"}
          </button>
        )}
      </div>
    </section>
  );
}

function BudgetMeter({ budget, amountUsdc, status }: { budget: BudgetState | null | undefined; amountUsdc: string; status: Status }) {
  if (status === "revoked" || status === "expired") {
    return <p className="mt-3 text-[12px] text-conduit-muted/70">This budget is no longer spendable.</p>;
  }
  if (!budget) return <p className="mt-3 text-[12px] text-conduit-muted/60">Reading budget…</p>;
  const cap = Number(formatUnits(budget.periodAmount, 6));
  const spent = Number(formatUnits(budget.spent, 6));
  const pct = cap > 0 ? Math.min(100, (spent / cap) * 100) : 0;
  return (
    <div className="mt-3">
      <div className="mono flex justify-between text-[12px]">
        <span className="text-conduit-muted">spent {spent.toFixed(2)} / {cap.toFixed(2)} USDC</span>
        <span className="text-white">{formatUnits(budget.available, 6)} left</span>
      </div>
      <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-conduit-border/60">
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${pct}%`, background: budget.exhausted ? "#7C3AED" : "#00E5FF" }}
        />
      </div>
      {budget.resetInSeconds > 0 && !budget.exhausted && (
        <p className="mono mt-1.5 text-[11px] text-conduit-muted/60">resets in {fmtDur(budget.resetInSeconds)}</p>
      )}
    </div>
  );
}

function SubMeter({ g, sub, amountUsdc, nowSec, status }: { g: GrantRecord; sub: SubscriptionState | null | undefined; amountUsdc: string; nowSec: number; status: Status }) {
  if (status === "revoked" || status === "expired") {
    return <p className="mt-3 text-[12px] text-conduit-muted/70">This subscription can no longer charge.</p>;
  }
  if (!sub) return <p className="mt-3 text-[12px] text-conduit-muted/60">Reading period…</p>;
  const secsLeft = Math.max(0, sub.nextChargeAt - nowSec);
  const charged = sub.chargedThisPeriod;
  return (
    <div className="mt-3 flex items-center gap-2 text-[12px]">
      <span
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ background: charged ? "#7C3AED" : "#00E5FF", boxShadow: `0 0 8px ${charged ? "#7C3AED" : "#00E5FF"}` }}
      />
      <span className="text-white">
        {!sub.active ? "Ready for the first charge" : charged ? `Charged this period · next in ${fmtDur(secsLeft)}` : "Ready to charge this period"}
      </span>
      <span className="mono ml-auto text-conduit-muted">{amountUsdc} USDC / {fmtDur(g.periodSeconds ?? 0)}</span>
    </div>
  );
}

function Fact({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-conduit-muted/60">{k}</span>
      <span className="text-white">{v}</span>
    </div>
  );
}

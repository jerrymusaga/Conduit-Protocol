"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAccount, useWalletClient } from "wagmi";
import {
  usePrivy,
  useLogin,
  useSign7702Authorization,
  useWallets,
  getEmbeddedConnectedWallet,
} from "@privy-io/react-auth";
import { useSetActiveWallet } from "@privy-io/wagmi";
import { formatUnits, type Hex } from "viem";
import { createCoordinatorAccount, type Coordinator } from "@/lib/grant";
import { feeCapAtoms, type Eip7702Authorization } from "@/lib/payment";
import {
  fetchCatalog,
  fetch402,
  payAndClaim,
  fetchJob,
  type CatalogService,
  type PaymentRequirements,
} from "@/lib/endpoint";
import { discoverAgents, type DiscoveredAgent } from "@/lib/discovery";
import {
  grantSubscription,
  buildSubscriptionPayment,
  readSubscriptionState,
  termsFromRequirements,
  cancelSubscription,
  type SubscriptionGrant,
  type SubscriptionState,
} from "@/lib/subscription";
import { registerGrant, markGrantRevoked } from "@/lib/grants";
import { useFacilitatorEvents } from "@/lib/useFacilitatorEvents";
import { config } from "@/lib/config";
import { publicClient } from "@/lib/chain";
import { Erc7710Inspector, type InspectorBinding } from "@/components/Erc7710Inspector";

/* ===========================================================================
   Conduit — the SUBSCRIPTION beat.
   The sibling of /demo (one-shot, X402ReceiptEnforcer). Here the USER signs a
   SERVICE-BOUND root: a single caveat (X402SubscriptionEnforcer) that says
   "pay exactly N USDC to this merchant, once per period — and nothing else."
   The money shot: charge once → ✓; charge again in the same period → BLOCKED
   on-chain (already-charged-this-period). A recurring payment rate-limited by
   a caveat the agent physically cannot exceed — which MetaMask's own x402
   "recurring" (a rolling spend cap) does not enforce.
   =========================================================================== */

type ChargeStage = "requested" | "allowed" | "settling" | "settled" | "blocked" | "failed";

interface ChargeCard {
  correlationId: string;
  /** 1-based period this charge targeted (optimistic until confirmed). */
  period: number;
  /** Was this a deliberate "force charge again" (expected to be blocked)? */
  forced: boolean;
  stage: ChargeStage;
  reason?: string | null;
  txHash?: string | null;
  /** How the settlement confirmed: "webhook" (1Shot signed push) or "poll". */
  confirmedVia?: "webhook" | "poll" | null;
}

const now = () => new Date().toLocaleTimeString("en-US", { hour12: false });

export default function SubscriptionPage() {
  // Privy (auth) + wagmi (wallet client) — same wiring as /demo.
  const { ready, authenticated, logout } = usePrivy();
  const { login } = useLogin();
  const { signAuthorization } = useSign7702Authorization();
  const { wallets } = useWallets();
  const { setActiveWallet } = useSetActiveWallet();
  const { address, isConnected } = useAccount();
  const { data: walletClient } = useWalletClient({ chainId: config.chainId });
  const connected = ready && authenticated && isConnected && !!address;

  useEffect(() => {
    if (!authenticated || wallets.length === 0) return;
    const embedded = getEmbeddedConnectedWallet(wallets);
    const ethExternal = wallets.find((w) => w.chainId?.startsWith("eip155:"));
    const target = embedded ?? ethExternal ?? wallets[0];
    if (!target) return;
    if (address && address.toLowerCase() === target.address.toLowerCase()) return;
    void setActiveWallet(target);
  }, [authenticated, wallets, address, setActiveWallet]);

  // Subscription catalog + 402 requirements (loaded once).
  const [service, setService] = useState<CatalogService | null>(null);
  const [req, setReq] = useState<PaymentRequirements | null>(null);
  // The subscription marketplace: pick which recurring service to opt into.
  const [subServices, setSubServices] = useState<CatalogService[]>([]);
  const [subAgents, setSubAgents] = useState<DiscoveredAgent[]>([]); // registry tags

  // Grant / charge state.
  const coordinatorRef = useRef<Coordinator | null>(null);
  const [grant, setGrant] = useState<SubscriptionGrant | null>(null);
  const [authorization, setAuthorization] = useState<Eip7702Authorization | null>(null);
  const [subState, setSubState] = useState<SubscriptionState | null>(null);
  const [charges, setCharges] = useState<ChargeCard[]>([]);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<{ t: string; text: string }[]>([]);
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  const logEndRef = useRef<HTMLDivElement>(null);

  // Buyer-side controls set at subscribe time.
  // Absolute expiry (datetime-local) + a "never" toggle (subscriptions can run
  // open-ended until revoked).
  const [subExpiryAt, setSubExpiryAt] = useState<string>(() => toLocalDatetime(Date.now() + 3600_000));
  const [noExpiry, setNoExpiry] = useState(false);
  const [feeBudget, setFeeBudget] = useState<string>("0.30"); // gas budget / period (USDC)
  const [cancelled, setCancelled] = useState(false);

  const { events, connected: sseConnected } = useFacilitatorEvents(connected);
  const seenEvents = useRef(new Set<string>());

  const subscribed = !!grant;
  // Past the TimestampEnforcer's `before` bound, every charge reverts on-chain.
  const expired = !!grant?.expiry && nowSec >= grant.expiry;
  // The sub-enforcer guard keys on the root hash; once charged this period a
  // re-charge reverts. Recompute live so the period rollover unlocks the UI.
  const canChargeNow = !expired && (!subState || nowSec >= subState.nextChargeAt);
  const secsUntilNext = subState ? Math.max(0, subState.nextChargeAt - nowSec) : 0;

  const append = useCallback((text: string) => {
    setLog((l) => [...l, { t: now(), text }]);
    requestAnimationFrame(() => logEndRef.current?.scrollIntoView({ behavior: "smooth" }));
  }, []);

  // Discover the subscription marketplace; default-select the fast (60s) feed so
  // the recurring beat shows quickly. The user can pick another before subscribing.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [catalog, market] = await Promise.all([fetchCatalog(), discoverAgents()]);
        const subs = catalog.filter((s) => s.kind === "subscription");
        if (subs.length === 0) {
          append("No subscription services in the catalog.");
          return;
        }
        if (cancelled) return;
        setSubServices(subs);
        setSubAgents(market.filter((m) => m.paymentKind === "subscription"));
        const def = subs.find((s) => s.id === "pulse-feed") ?? subs[0];
        const requirements = await fetch402(def.resource);
        if (cancelled) return;
        setService(def);
        setReq(requirements);
      } catch (e) {
        append(`Could not load subscription services · ${errMsg(e)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [append]);

  // 1s tick: drives the countdown + the period-rollover unlock.
  useEffect(() => {
    const id = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  // Refresh on-chain period state periodically while subscribed. Only commit a
  // new state object when the meaningful on-chain fields actually change, so the
  // 10s poll doesn't re-render (and flicker) the panel every tick — the 1s
  // countdown is derived from nowSec against the stable nextChargeAt instead.
  const refreshState = useCallback(async () => {
    if (!grant) return;
    try {
      const next = await readSubscriptionState(grant);
      setSubState((prev) =>
        prev &&
        prev.startDate === next.startDate &&
        prev.lastChargedPeriod === next.lastChargedPeriod &&
        prev.active === next.active
          ? prev
          : next
      );
    } catch {
      /* transient RPC error — keep the last known state */
    }
  }, [grant]);

  useEffect(() => {
    if (!grant) return;
    void refreshState();
    const id = setInterval(() => void refreshState(), 10_000);
    return () => clearInterval(id);
  }, [grant, refreshState]);

  // Annotate charge cards from the facilitator's live SSE stream.
  useEffect(() => {
    for (const ev of events) {
      if (seenEvents.current.has(ev.id)) continue;
      seenEvents.current.add(ev.id);
      if (!ev.correlationId) continue;
      setCharges((cs) =>
        cs.map((c) => {
          if (c.correlationId !== ev.correlationId) return c;
          if (ev.stage === "permission") {
            return ev.allowed
              ? { ...c, stage: c.stage === "settled" ? c.stage : "allowed" }
              : { ...c, stage: "blocked", reason: ev.reason };
          }
          if (ev.stage === "settle") return { ...c, stage: "settling", txHash: ev.txHash };
          if (ev.stage === "settled")
            return ev.status === "confirmed"
              ? { ...c, stage: "settled", txHash: ev.txHash }
              : { ...c, stage: "failed", reason: ev.reason };
          return c;
        })
      );
    }
  }, [events]);

  const patchCard = (correlationId: string, patch: Partial<ChargeCard>) =>
    setCharges((cs) => cs.map((c) => (c.correlationId === correlationId ? { ...c, ...patch } : c)));

  // --- actions -------------------------------------------------------------

  const connect = async () => {
    if (busy) return;
    try {
      login();
    } catch (e) {
      append(`Sign-in failed · ${errMsg(e)}`);
    }
  };

  const disconnect = async () => {
    try {
      await logout();
    } finally {
      coordinatorRef.current = null;
      setGrant(null);
      setAuthorization(null);
      setSubState(null);
      setCharges([]);
      setLog([]);
      setCancelled(false);
    }
  };

  // Cancel = disableDelegation on the subscription root. A direct on-chain tx
  // from the user's own account (only the delegator can revoke). Needs gas (ETH).
  const cancel = async () => {
    if (busy || !grant || !walletClient || !address) return;
    setBusy(true);
    append("Cancelling subscription · revoking the delegation on-chain (needs a little ETH for gas)…");
    try {
      const tx = await cancelSubscription({ walletClient, userAddress: address, grant });
      append(`Revoke tx sent · ${shorten(tx)} — awaiting confirmation…`);
      await publicClient.waitForTransactionReceipt({ hash: tx });
      void markGrantRevoked(grant.delegationHash, address); // reflect in /portfolio
      setCancelled(true);
      setGrant(null);
      setSubState(null);
      coordinatorRef.current = null;
      append("Subscription cancelled ✓ · every future charge against this grant now reverts on-chain");
    } catch (e) {
      append(`Cancel failed · ${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  };

  // Pick a different subscription to opt into (only before subscribing).
  const selectService = async (svc: CatalogService) => {
    if (busy || subscribed || svc.id === service?.id) return;
    try {
      const requirements = await fetch402(svc.resource);
      setService(svc);
      setReq(requirements);
      append(`Selected ${svc.label} · every ${requirements.subscription?.periodSeconds ?? "?"}s`);
    } catch (e) {
      append(`Could not load ${svc.label} · ${errMsg(e)}`);
    }
  };

  // Subscribe: the SERVICE-BOUND root the user signs (+ a tiny gas-fee budget),
  // plus the 7702 authorization bundled into the first charge.
  const subscribe = async () => {
    if (busy || !req || !service) return;
    if (!walletClient || !address) {
      append(`Waiting for wallet to bind… (wallets=${wallets.length})`);
      return;
    }
    if (!req.subscription) {
      append("This service did not advertise subscription terms.");
      return;
    }
    setBusy(true);
    try {
      const coordinator = createCoordinatorAccount();
      coordinatorRef.current = coordinator;
      append(`Coordinator session account · ${shorten(coordinator.address)}`);

      const embeddedWallet = getEmbeddedConnectedWallet(wallets);
      if (embeddedWallet) {
        append(`Signing EIP-7702 authorization · designating ${shorten(config.eip7702Impl)}…`);
        const nonce = await publicClient.getTransactionCount({
          address: embeddedWallet.address as Hex,
        });
        const auth = await signAuthorization(
          { contractAddress: config.eip7702Impl, chainId: config.chainId, nonce },
          { address: embeddedWallet.address }
        );
        setAuthorization({
          chainId: auth.chainId,
          address: auth.address as Hex,
          nonce: auth.nonce,
          r: auth.r,
          s: auth.s,
          yParity: (auth.yParity === 1 ? 1 : 0) as 0 | 1,
        });
        append("EIP-7702 authorization signed · bundled into the first charge");
      } else {
        append("External wallet can't sign EIP-7702 — sign in with email for the full flow.");
      }

      const terms = termsFromRequirements(req, req.subscription);
      const nowSecs = Math.floor(Date.now() / 1000);
      const expiry = noExpiry
        ? undefined
        : Math.max(nowSecs + 60, Math.floor(new Date(subExpiryAt).getTime() / 1000));
      append(
        `Signing the subscription: ${service.priceUsdc} USDC → ${shorten(terms.recipient)} every ${terms.periodSeconds}s` +
          (expiry ? `, expires in ${fmtDuration(expiry - nowSecs)}` : ", no expiry") + "…"
      );
      // Size the gas-fee budget root to at least the live dynamic fee cap, so a
      // high gas quote doesn't blow past it (falls back to the user's input).
      const dynamicFeeUsdc = req.feeEstimate ? Number(formatUnits(feeCapAtoms(req.feeEstimate), 6)) : 0;
      const feeBudgetUsdc = Math.max(Number(feeBudget) || 0, dynamicFeeUsdc).toFixed(6);
      const g = await grantSubscription({
        walletClient,
        userAddress: address,
        coordinator,
        terms,
        feeBudgetUsdc,
        expiry,
      });
      setGrant(g);
      setCancelled(false);
      append("Subscription approved · your signature binds merchant + amount + cadence on-chain");
      // Register in the per-wallet grants index so /portfolio can list it.
      void registerGrant({
        id: g.delegationHash,
        user: address,
        kind: "subscription",
        label: service.label,
        coordinator: coordinator.address,
        token: g.terms.token,
        amount: g.terms.amountPerPeriod.toString(),
        expiry: g.expiry,
        periodSeconds: g.terms.periodSeconds,
        delegationHash: g.delegationHash,
        enforcer: g.terms.enforcer,
        merchant: g.terms.recipient,
        context: g.context,
      });
    } catch (e) {
      console.error("[conduit] subscribe failed →", e);
      append(`Subscribe failed · ${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  };

  // Charge the subscription this period. `forced` = the user deliberately
  // re-charges (the BLOCKED beat) even when this period is already paid.
  const charge = async (forced: boolean) => {
    if (busy || !grant || !coordinatorRef.current || !req || !service) return;
    setBusy(true);
    const correlationId = crypto.randomUUID();
    const period = subState ? subState.currentPeriod : 1;
    setCharges((cs) => [
      { correlationId, period, forced, stage: "requested" as ChargeStage },
      ...cs,
    ]);
    append(forced ? "Force-charging again this period…" : `Charging period ${period}…`);
    try {
      const built = await buildSubscriptionPayment({
        grant,
        coordinator: coordinatorRef.current,
        req,
        authorization: authorization ?? undefined,
      });
      const r = await payAndClaim(built.paymentPayload, {
        path: service.resource,
        agent: "Subscriber",
        correlationId,
      });
      if (r.ok) {
        patchCard(correlationId, { stage: "settled", txHash: r.settlement?.transaction ?? null });
        setAuthorization(null); // designation consumed by the first settled tx
        append(`Charged ✓ · ${service.priceUsdc} USDC settled on-chain`);
        // 1Shot confirms out of band; poll the job for the final tx + HOW it
        // confirmed — the signed-webhook path is the live receipts layer we want
        // to surface (the "confirmed via 1Shot signed webhook" chip).
        if (r.settlement?.jobId) void pollChargeConfirmation(correlationId, r.settlement.jobId);
      } else {
        patchCard(correlationId, { stage: "blocked", reason: r.error });
        append(`Blocked · ${r.error}`);
      }
      await refreshState();
    } catch (e) {
      patchCard(correlationId, { stage: "blocked", reason: errMsg(e) });
      append(`Charge failed · ${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  };

  // Poll the facilitator job until it confirms, then stamp the card with the tx
  // and HOW it confirmed. 1Shot's Ed25519-signed webhook is the preferred path
  // (the receipts layer); the getStatus poll is the fallback.
  const pollChargeConfirmation = async (correlationId: string, jobId: string) => {
    const deadline = Date.now() + 150_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      const job = await fetchJob(jobId);
      if (!job) continue;
      if (job.transaction) patchCard(correlationId, { txHash: job.transaction });
      if (job.status === "confirmed") {
        patchCard(correlationId, {
          stage: "settled",
          txHash: job.transaction ?? null,
          confirmedVia: job.confirmedVia ?? null,
        });
        if (job.confirmedVia === "webhook") append("Confirmed via 1Shot signed webhook ✓");
        return;
      }
      if (job.status === "failed") return;
    }
  };

  // --- render --------------------------------------------------------------

  const periodLabel = req?.subscription ? `${req.subscription.periodSeconds}s` : "—";

  // The ERC-7710 binding every charge carries (same enforcer + terms each time).
  const inspectorBinding: InspectorBinding | null =
    req?.subscription && service
      ? {
          kind: "subscription",
          enforcerName: "X402SubscriptionEnforcer",
          enforcerAddr: req.subscription.enforcer,
          terms: [
            { label: "amount", value: `${service.priceUsdc} USDC (exact)` },
            { label: "merchant", value: shorten(req.payTo) },
            { label: "cadence", value: `1×/${req.subscription.periodSeconds}s` },
          ],
        }
      : null;

  return (
    <main className="min-h-screen">
      {/* top bar */}
      <div className="border-b border-conduit-border/60">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <Link href="/" className="flex items-center gap-2.5">
            <Image src="/images/conduit-logo.png" alt="Conduit" width={28} height={28} className="h-7 w-7" />
            <span className="font-semibold tracking-tight">Conduit</span>
            <span className="mono ml-2 rounded-md border border-conduit-border px-2 py-0.5 text-[11px] text-conduit-muted">
              safe subscriptions
            </span>
          </Link>
          <div className="flex items-center gap-3">
            <Link
              href="/demo"
              className="text-xs text-conduit-muted underline-offset-4 hover:text-white hover:underline"
            >
              ← one-shot console
            </Link>
            <Link
              href="/portfolio"
              className="text-xs text-conduit-muted underline-offset-4 hover:text-white hover:underline"
            >
              portfolio →
            </Link>
            {connected && (
              <span className="mono flex items-center gap-1.5 text-[11px] text-conduit-muted">
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ background: sseConnected ? "#00E5FF" : "#666" }}
                />
                {sseConnected ? "live" : "connecting"}
              </span>
            )}
            {connected && address ? (
              <button
                onClick={disconnect}
                disabled={busy}
                className="text-xs text-conduit-muted underline-offset-4 hover:text-white hover:underline disabled:opacity-40"
              >
                {shorten(address)} · sign out
              </button>
            ) : (
              <button onClick={connect} disabled={!ready || busy} className="btn-primary text-sm disabled:opacity-40">
                {ready ? "Sign in" : "Loading…"}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Safety hero — the differentiator as the headline, not a footnote. */}
      <SubscriptionHero subscribed={subscribed} />

      <div className="mx-auto grid max-w-7xl gap-6 px-6 py-8 lg:grid-cols-12">
        {/* LEFT: the subscription permission + period state */}
        <div className="space-y-6 lg:col-span-4">
          <section className="panel p-6">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-conduit-muted">
                Your subscription
              </h2>
              <span
                className={`mono rounded-md px-2 py-0.5 text-[11px] ${subscribed ? "bg-conduit-cyan/15 text-conduit-cyan" : "border border-conduit-border text-conduit-muted"}`}
              >
                {subscribed ? "active" : "not subscribed"}
              </span>
            </div>

            {cancelled && !subscribed && (
              <div className="mt-4 rounded-lg border border-conduit-magenta/40 bg-conduit-magenta/5 p-3 text-[12px] text-conduit-magenta">
                Subscription cancelled — the delegation is revoked on-chain; no further charges
                can settle. Approve again to start a new one.
              </div>
            )}

            {/* Subscription marketplace — discovered on ERC-8004; pick one. */}
            {subServices.length > 0 && (
              <div className="mt-4">
                <p className="text-[11px] uppercase tracking-wide text-conduit-muted/70">
                  Discovered on ERC-8004 · {subServices.length} subscriptions
                  {subAgents.some((a) => a.source === "registry") ? " (on-chain)" : ""}
                </p>
                <div className="mt-2 grid gap-2 sm:grid-cols-3">
                  {subServices.map((s) => {
                    const sel = s.id === service?.id;
                    const agent = subAgents.find((a) => a.id === s.id);
                    return (
                      <button
                        key={s.id}
                        onClick={() => selectService(s)}
                        disabled={busy || subscribed}
                        className={`rounded-lg border p-2.5 text-left transition disabled:cursor-not-allowed ${
                          sel ? "border-conduit-cyan/60 bg-conduit-cyan/10" : "border-conduit-border/60 hover:border-conduit-cyan/40"
                        } ${subscribed && !sel ? "opacity-40" : ""}`}
                      >
                        <p className="text-[12px] font-semibold text-white">{sel ? "● " : ""}{s.label}</p>
                        <p className="mono mt-0.5 text-[10px] text-conduit-muted">
                          {s.priceUsdc} USDC · every {fmtPeriod(agent?.subscription?.periodSeconds)}
                        </p>
                        {agent?.agentId && (
                          <p className="mono mt-0.5 text-[9.5px] text-conduit-cyan/80">on-chain · agent #{agent.agentId}</p>
                        )}
                      </button>
                    );
                  })}
                </div>
                {subscribed && <p className="mt-1.5 text-[10px] text-conduit-muted/60">Cancel to switch subscriptions.</p>}
              </div>
            )}

            {service && req ? (
              <div className="mt-4 space-y-3">
                <div className="rounded-lg border border-conduit-border/60 p-3">
                  <p className="text-sm font-semibold text-white">{service.label}</p>
                  <p className="mt-0.5 text-[12px] text-conduit-muted">{service.description}</p>
                  <div className="mono mt-3 space-y-1 text-[12px]">
                    <Row k="charge" v={`${service.priceUsdc} USDC (exact)`} />
                    <Row k="cadence" v={`once / ${periodLabel}`} />
                    <Row k="paid to" v={shorten(req.payTo)} />
                    <Row k="on-chain rule" v={shorten(req.subscription?.enforcer ?? null)} />
                  </div>
                </div>

                {!subscribed ? (
                  <>
                    <p className="text-[12px] leading-relaxed text-conduit-muted">
                      You sign ONE root delegation whose only caveat is this subscription. Your
                      signature is the guardrail — the agent can pay this exact amount to this
                      merchant once per period, and <span className="text-white">nothing else</span>.
                    </p>

                    {/* buyer-side bounds */}
                    <div className="space-y-2.5 rounded-lg border border-conduit-border/60 p-3">
                      <div className="space-y-1.5 text-[12px]">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-conduit-muted">expires</span>
                          <label className="flex items-center gap-1.5 text-conduit-muted">
                            <input
                              type="checkbox"
                              checked={noExpiry}
                              onChange={(e) => setNoExpiry(e.target.checked)}
                              disabled={!connected || busy}
                            />
                            never
                          </label>
                        </div>
                        <input
                          type="datetime-local"
                          value={subExpiryAt}
                          min={toLocalDatetime(Date.now() + 60_000)}
                          onChange={(e) => setSubExpiryAt(e.target.value)}
                          disabled={!connected || busy || noExpiry}
                          className="mono w-full rounded-lg border border-conduit-border bg-conduit-panel px-2 py-1.5 text-white outline-none focus:border-conduit-cyan disabled:opacity-40"
                        />
                        <div className="flex flex-wrap gap-1.5">
                          {[
                            { label: "5m", seconds: 300 },
                            { label: "1h", seconds: 3600 },
                            { label: "1d", seconds: 86400 },
                          ].map((o) => (
                            <button
                              key={o.seconds}
                              type="button"
                              onClick={() => {
                                setNoExpiry(false);
                                setSubExpiryAt(toLocalDatetime(Date.now() + o.seconds * 1000));
                              }}
                              disabled={!connected || busy}
                              className="mono rounded-md border border-conduit-border px-2 py-0.5 text-[11px] text-conduit-muted transition-colors hover:border-conduit-cyan/50 hover:text-conduit-cyan disabled:opacity-40"
                            >
                              +{o.label}
                            </button>
                          ))}
                        </div>
                      </div>
                      <label className="flex items-center justify-between gap-2 text-[12px]">
                        <span className="text-conduit-muted">gas budget / period</span>
                        <span className="flex items-center gap-1">
                          <input
                            type="number" min="0" step="0.01" inputMode="decimal"
                            value={feeBudget}
                            onChange={(e) => setFeeBudget(e.target.value)}
                            disabled={!connected || busy}
                            className="mono w-20 rounded-lg border border-conduit-border bg-transparent px-2 py-1.5 text-right text-white outline-none focus:border-conduit-cyan disabled:opacity-40"
                          />
                          <span className="text-conduit-muted">USDC</span>
                        </span>
                      </label>
                      <p className="text-[11px] leading-relaxed text-conduit-muted/70">
                        Both are <span className="text-white">your</span> bounds: the subscription
                        auto-expires, and gas (paid to 1Shot in USDC) is capped per period.
                      </p>
                    </div>

                    <button
                      onClick={subscribe}
                      disabled={!connected || busy}
                      className="btn-primary w-full justify-center text-sm disabled:opacity-40"
                    >
                      {busy ? "Signing…" : "Approve subscription"}
                    </button>
                  </>
                ) : (
                  <div className="space-y-3">
                    <p className="text-[12px] leading-relaxed text-conduit-muted">
                      Bound on-chain: <span className="text-white">{service.priceUsdc} USDC</span> →{" "}
                      <span className="mono text-conduit-cyan">{shorten(req.payTo)}</span>, once per{" "}
                      {periodLabel}.
                    </p>
                    <div className="mono space-y-1 text-[12px]">
                      <Row
                        k="expires"
                        v={
                          !grant?.expiry
                            ? "never"
                            : expired
                              ? "expired ✗"
                              : `in ${fmtDuration(grant.expiry - nowSec)}`
                        }
                      />
                      <Row k="gas budget" v={`${grant?.feeGrant.periodAmountUsdc ?? feeBudget} USDC / period`} />
                    </div>
                    <button
                      onClick={cancel}
                      disabled={busy}
                      className="w-full rounded-lg border border-conduit-magenta/40 px-3 py-2 text-xs font-medium text-conduit-magenta transition-colors hover:bg-conduit-magenta/10 disabled:opacity-40"
                    >
                      {busy ? "Working…" : "Cancel subscription (revoke on-chain)"}
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <p className="mt-4 text-[13px] text-conduit-muted">Loading subscription service…</p>
            )}
          </section>

          {/* Period state — the recurring meter */}
          {subscribed && (
            <section className="panel p-6">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-conduit-muted">
                This period
              </h2>
              <div className="mt-4 flex items-center gap-4">
                <CountdownRing
                  secsLeft={secsUntilNext}
                  periodSecs={req?.subscription?.periodSeconds ?? 1}
                  ready={canChargeNow && !expired}
                />
                <div>
                  <p className="text-sm font-medium text-white">
                    {expired
                      ? "Subscription expired"
                      : !subState?.active
                        ? "Ready for the first charge"
                        : canChargeNow
                          ? "Ready to charge this period"
                          : "Charged this period ✓"}
                  </p>
                  <p className="mt-0.5 text-[12px] text-conduit-muted">
                    {expired
                      ? "Every charge now reverts on-chain."
                      : canChargeNow
                        ? "One charge will settle; a second is blocked."
                        : "Locked by your signature until the next period."}
                  </p>
                </div>
              </div>

              <div className="mono mt-4 space-y-1.5 text-[12px]">
                <Row k="period" v={subState ? `#${subState.currentPeriod}` : "—"} />
                <Row
                  k="last charged"
                  v={subState && subState.lastChargedPeriod > 0 ? `period #${subState.lastChargedPeriod}` : "never"}
                />
                <Row
                  k="next charge"
                  v={expired ? "expired" : canChargeNow ? "now" : `in ${secsUntilNext}s`}
                />
              </div>

              <div className="mt-5 space-y-2">
                <button
                  onClick={() => charge(false)}
                  disabled={busy || !canChargeNow}
                  className="btn-primary w-full justify-center text-sm disabled:opacity-40"
                >
                  {busy
                    ? "Working…"
                    : expired
                      ? "Subscription expired"
                      : canChargeNow
                        ? "Charge this period"
                        : `Locked · next in ${secsUntilNext}s`}
                </button>
                <button
                  onClick={() => charge(true)}
                  disabled={busy}
                  className="w-full rounded-lg border border-conduit-magenta/40 px-3 py-2 text-xs font-medium text-conduit-magenta transition-colors hover:bg-conduit-magenta/10 disabled:opacity-40"
                >
                  Force charge again now →
                </button>
                <p className="text-[11px] leading-relaxed text-conduit-muted/70">
                  Already charged this period? &ldquo;Force charge again&rdquo; submits a real
                  payment — Conduit blocks it on-chain (<span className="mono">already-charged-this-period</span>).
                  A recurring charge rate-limited by a caveat, not a server.
                </p>
              </div>
            </section>
          )}
        </div>

        {/* CENTER: the charge feed */}
        <div className="lg:col-span-5">
          <section className="panel p-0">
            <div className="flex items-center justify-between border-b border-conduit-border/60 px-5 py-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-conduit-muted">
                Charges
              </h2>
              <span className="mono text-[11px] text-conduit-muted">via Conduit facilitator · erc7710</span>
            </div>
            <div className="min-h-[460px] space-y-3 px-5 py-5">
              {charges.length === 0 ? (
                <div className="pt-12 text-center">
                  <p className="mono text-sm text-conduit-muted">
                    {connected ? (subscribed ? "Charge the subscription to begin." : "Approve the subscription to begin.") : "Sign in to begin."}
                  </p>
                  <p className="mx-auto mt-3 max-w-md text-[12px] leading-relaxed text-conduit-muted/70">
                    Each charge flows request → check → settle → delivered. Your signed rule lets
                    exactly one charge per period through; a second in the same period is
                    rejected on-chain.
                  </p>
                </div>
              ) : (
                <>
                  <p className="text-[12px] leading-relaxed text-conduit-muted">
                    Each charge is an <span className="text-white">ERC-7710 delegation</span> redeemed
                    through <span className="text-white">MetaMask&apos;s DelegationManager</span>, bounded by
                    the <span className="text-conduit-cyan">X402SubscriptionEnforcer</span>. Expand a card to
                    inspect the redemption + on-chain proof.
                  </p>
                  {charges.map((c) => (
                    <ChargeCardView
                      key={c.correlationId}
                      card={c}
                      priceUsdc={service?.priceUsdc ?? "—"}
                      binding={inspectorBinding}
                    />
                  ))}
                </>
              )}
            </div>
          </section>
        </div>

        {/* RIGHT: activity log */}
        <div className="lg:col-span-3">
          <section className="panel p-0">
            <div className="border-b border-conduit-border/60 px-5 py-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-conduit-muted">Activity</h2>
            </div>
            <div className="h-[460px] overflow-y-auto px-4 py-3">
              {log.length === 0 ? (
                <p className="mono text-xs text-conduit-muted">—</p>
              ) : (
                <div className="space-y-1.5">
                  {log.map((l, i) => (
                    <div key={i} className="mono flex gap-2 text-[11px] leading-relaxed">
                      <span className="shrink-0 text-conduit-muted/50">{l.t}</span>
                      <span className="text-conduit-muted">{l.text}</span>
                    </div>
                  ))}
                  <div ref={logEndRef} />
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}

// --- safety hero: traditional recurring billing vs a Conduit subscription ----

/** The differentiator, made the headline (not a footnote): a card-on-file
 *  subscription trusts the merchant; a Conduit subscription is bound by YOUR
 *  signature on YOUR own root — exact amount, once per period, revocable. */
function SubscriptionHero({ subscribed }: { subscribed: boolean }) {
  const rows: { label: string; old: string; conduit: string }[] = [
    { label: "Who holds the authority", old: "Merchant stores your card", conduit: "You sign a rule on your own account" },
    { label: "Amount", old: "Whatever they charge", conduit: "Exact amount, fixed by your signature" },
    { label: "Frequency", old: "Whenever they decide", conduit: "Once per period — a 2nd reverts" },
    { label: "If the agent is hijacked", old: "It can redirect or overcharge", conduit: "Physically can't — the rule forbids it" },
    { label: "Cancelling", old: "Email support, then wait", conduit: "Revoke on-chain yourself, instantly" },
  ];
  return (
    <section className="panel reveal mx-auto mt-6 max-w-7xl overflow-hidden p-0">
      <div className="grid gap-0 md:grid-cols-2">
        {/* Traditional */}
        <div className="border-b border-conduit-border/60 p-6 md:border-b-0 md:border-r">
          <p className="mono text-[11px] uppercase tracking-wide text-conduit-muted/70">
            Card on file
          </p>
          <h3 className="mt-1 text-base font-semibold text-conduit-muted">Traditional recurring billing</h3>
          <ul className="mt-4 space-y-2.5">
            {rows.map((r) => (
              <li key={r.label} className="flex items-start gap-2 text-[12.5px]">
                <span className="mt-0.5 shrink-0 text-conduit-magenta/70">✗</span>
                <span className="text-conduit-muted">
                  <span className="text-conduit-muted/60">{r.label}: </span>
                  {r.old}
                </span>
              </li>
            ))}
          </ul>
        </div>
        {/* Conduit */}
        <div className="relative bg-conduit-cyan/[0.03] p-6">
          <p className="mono text-[11px] uppercase tracking-wide text-conduit-cyan/80">
            Your signature
          </p>
          <h3 className="mt-1 text-base font-semibold text-white">A Conduit subscription</h3>
          <ul className="mt-4 space-y-2.5">
            {rows.map((r) => (
              <li key={r.label} className="flex items-start gap-2 text-[12.5px]">
                <span className="mt-0.5 shrink-0 text-conduit-cyan">✓</span>
                <span className="text-white">
                  <span className="text-conduit-muted/60">{r.label}: </span>
                  <span className="text-white">{r.conduit}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="border-t border-conduit-border/60 bg-conduit-panel/40 px-6 py-3 text-center">
        <p className="text-[12px] text-conduit-muted">
          {subscribed
            ? "Your subscription is live below — try "
            : "Recurring, without the trust fall. Approve one below, then try "}
          <span className="text-white">“Force charge again”</span>
          {" "}— the agent can’t over-charge, and Conduit proves it on-chain.
        </p>
      </div>
    </section>
  );
}

/** A circular countdown ring for "next charge in Xs" — the period mechanic,
 *  visualized. Fills as the period elapses; full + cyan when a charge unlocks. */
function CountdownRing({ secsLeft, periodSecs, ready }: { secsLeft: number; periodSecs: number; ready: boolean }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  const frac = periodSecs > 0 ? Math.min(1, Math.max(0, (periodSecs - secsLeft) / periodSecs)) : 1;
  const color = ready ? "#00E5FF" : "#7C3AED";
  return (
    <div className="relative h-[64px] w-[64px] shrink-0">
      <svg viewBox="0 0 64 64" className="h-full w-full -rotate-90">
        <circle cx="32" cy="32" r={r} fill="none" stroke="currentColor" strokeWidth="4" className="text-conduit-border/50" />
        <circle
          cx="32" cy="32" r={r} fill="none" stroke={color} strokeWidth="4" strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={ready ? 0 : c * (1 - frac)}
          style={{ transition: "stroke-dashoffset 1s linear, stroke 0.3s" }}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="mono text-[12px] font-semibold" style={{ color }}>
          {ready ? "now" : `${secsLeft}s`}
        </span>
      </div>
    </div>
  );
}

// --- charge card -------------------------------------------------------------

function ChargeCardView({
  card,
  priceUsdc,
  binding,
}: {
  card: ChargeCard;
  priceUsdc: string;
  binding: InspectorBinding | null;
}) {
  const [open, setOpen] = useState(false);
  const blocked = card.stage === "blocked" || card.stage === "failed";
  const done = card.stage === "settled";
  const working = card.stage === "requested" || card.stage === "settling" || card.stage === "allowed";
  const accent = blocked ? "#EC4899" : done ? "#00E5FF" : "#7C3AED";

  const caption = blocked
    ? card.forced
      ? "Conduit BLOCKED the re-charge on-chain — already charged this period. No money moved. ✓"
      : "Conduit blocked this charge on-chain. No money moved."
    : done
      ? `Charged ${priceUsdc} USDC on-chain for period #${card.period}.`
      : working
        ? "Submitting the subscription charge to Conduit…"
        : "";

  return (
    <div className="reveal rounded-xl border px-4 py-3.5 transition-all" style={{ borderColor: `${accent}55`, background: `${accent}0a` }}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span
            className={`h-2.5 w-2.5 rounded-full ${working ? "animate-pulse" : ""}`}
            style={{ background: accent, boxShadow: `0 0 10px ${accent}` }}
          />
          <span className="mono text-[12px]">
            <span className="text-conduit-muted">period</span>{" "}
            <span className="font-semibold text-white">#{card.period}</span>
            {card.forced && <span className="ml-2 text-conduit-magenta">force re-charge</span>}
          </span>
        </div>
        <span className="mono text-xs font-semibold text-white">{priceUsdc} USDC</span>
      </div>

      <div className="mono mt-3 flex items-center gap-1.5 text-[11px]">
        <Step on={["requested", "allowed", "settling", "settled"].includes(card.stage)} label="402 request" />
        <Arrow />
        <Step on={["allowed", "settling", "settled"].includes(card.stage)} bad={blocked} label={blocked ? "7710 caveat ✗" : "7710 caveat ✓"} />
        <Arrow />
        <Step on={["settling", "settled"].includes(card.stage)} label="redeem" />
        <Arrow />
        <Step on={done} label="delivered" />
      </div>

      {caption && (
        <p className={`mt-2.5 text-[12px] leading-relaxed ${blocked ? "text-conduit-magenta" : done ? "text-conduit-cyan" : "text-conduit-violet"}`}>
          {caption}
        </p>
      )}
      {card.reason && <p className="mono mt-1.5 text-[11px] text-conduit-magenta/80">revert reason: {card.reason}</p>}

      {done && card.txHash && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <a
            href={`${config.explorerUrl}/tx/${card.txHash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="mono text-[11px] text-conduit-cyan underline-offset-2 hover:underline"
          >
            receipt {card.txHash.slice(0, 10)}… ↗
          </a>
          {card.confirmedVia === "webhook" ? (
            <span className="mono rounded bg-conduit-cyan/15 px-1.5 py-0.5 text-[10px] text-conduit-cyan">
              ✓ confirmed via 1Shot signed webhook
            </span>
          ) : card.confirmedVia === "poll" ? (
            <span className="mono rounded border border-conduit-border px-1.5 py-0.5 text-[10px] text-conduit-muted">
              confirmed via 1Shot
            </span>
          ) : null}
        </div>
      )}

      {binding && (
        <>
          <button
            onClick={() => setOpen((o) => !o)}
            className="mono mt-2 text-[11px] text-conduit-muted underline-offset-4 hover:text-conduit-cyan"
          >
            {open ? "▾ hide ERC-7710 details" : "▸ inspect ERC-7710"}
          </button>
          {open && <Erc7710Inspector binding={binding} txHash={card.txHash} />}
        </>
      )}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-conduit-muted">{k}</span>
      <span className="text-white">{v}</span>
    </div>
  );
}
function Step({ on, bad, label }: { on: boolean; bad?: boolean; label: string }) {
  const color = bad ? "text-conduit-magenta" : on ? "text-conduit-cyan" : "text-conduit-muted/40";
  return (
    <span className={color}>
      {bad ? "✗" : on ? "●" : "○"} {label}
    </span>
  );
}
function Arrow() {
  return <span className="text-conduit-muted/30">→</span>;
}

// --- helpers -----------------------------------------------------------------

function shorten(addr: string | null): string {
  if (!addr) return "—";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/** Human-friendly billing period: 60→"60s", 86400→"day", 604800→"week". */
function fmtPeriod(s?: number): string {
  if (!s) return "—";
  if (s < 3600) return `${s}s`;
  if (s < 86_400) return `${Math.round(s / 3600)}h`;
  if (s < 604_800) return "day";
  if (s < 2_592_000) return "week";
  return "month";
}
function toLocalDatetime(ms: number): string {
  const off = new Date(ms).getTimezoneOffset() * 60_000;
  return new Date(ms - off).toISOString().slice(0, 16);
}
function fmtDuration(sec: number): string {
  if (sec <= 0) return "0s";
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86400)}d`;
}
function errMsg(e: unknown): string {
  if (e && typeof e === "object") {
    const o = e as Record<string, unknown>;
    const data = o.data as Record<string, unknown> | undefined;
    const cause = o.cause as Record<string, unknown> | undefined;
    const candidates = [o.shortMessage, data?.message, cause?.shortMessage, cause?.message, o.message];
    for (const c of candidates) if (typeof c === "string" && c) return c;
  }
  return e instanceof Error ? e.message : String(e);
}

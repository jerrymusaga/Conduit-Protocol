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
import { createCoordinatorAccount, type Coordinator } from "@/lib/grant";
import { privateKeyToAccount } from "viem/accounts";
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
  saveSubSession,
  loadSubSessions,
  removeSubSession,
  type PersistedSubSession,
  type SubscriptionGrant,
  type SubscriptionState,
} from "@/lib/subscription";
import { gaslessRevoke } from "@/lib/revoke";
import { Toast, type ToastState } from "@/components/Toast";
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
  /** What this period's charge actually bought — a live Venice deliverable. */
  deliverable?: { headline?: string; body?: string; source?: string } | null;
}

const now = () => new Date().toLocaleTimeString("en-US", { hour12: false });

/** Per-product visual identity for the subscription cards — a real Venice-generated
 *  cover image (public/images/product-*.png) so each feed reads as a distinct
 *  "product", with a fallback glyph for any unmapped service. */
const PRODUCT_VISUAL: Record<string, { img: string; glyph: string; ring: string }> = {
  "pulse-feed":    { img: "/images/product-pulse.png", glyph: "📈", ring: "ring-conduit-cyan/30" },
  "daily-digest":  { img: "/images/product-alpha.png", glyph: "🧠", ring: "ring-conduit-violet/30" },
  "weekly-trends": { img: "/images/product-yield.png", glyph: "🌾", ring: "ring-emerald-400/30" },
};
const productVisual = (id: string) =>
  PRODUCT_VISUAL[id] ?? { img: "", glyph: "✦", ring: "ring-conduit-border" };

export default function SubscriptionPage() {
  // Privy (auth) + wagmi (wallet client) — same wiring as /demo.
  const { ready, authenticated, logout } = usePrivy();
  const { login } = useLogin();
  const { wallets } = useWallets();
  const { setActiveWallet } = useSetActiveWallet();
  const { address: wagmiAddress, isConnected: wagmiConnected } = useAccount();
  const { data: wagmiWalletClient } = useWalletClient({ chainId: config.chainId });

  // ConduitPay: passkey wallet when signed in via the shell that way, else the
  // wagmi-bound (Privy) wallet — privy behavior unchanged.
  const activeWallet = useActiveWallet();
  const embedded = useConduitEmbedded();
  const isPasskey = activeWallet.provider === "passkey";
  const address = isPasskey ? activeWallet.address : wagmiAddress;
  const isConnected = isPasskey ? activeWallet.isConnected : wagmiConnected;
  const walletClient = isPasskey ? activeWallet.walletClient : wagmiWalletClient;
  const connected = isPasskey
    ? activeWallet.isConnected && !!activeWallet.address
    : ready && authenticated && isConnected && !!address;

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
  // Buyer-selected cadence tier (index into req.subscription.tiers). 0 = the
  // seller's default, so behavior is unchanged unless the buyer picks another.
  const [tierIdx, setTierIdx] = useState(0);
  // The subscription marketplace: pick which recurring service to opt into.
  const [subServices, setSubServices] = useState<CatalogService[]>([]);
  const [subAgents, setSubAgents] = useState<DiscoveredAgent[]>([]); // registry tags

  // Grant / charge state.
  const coordinatorRef = useRef<Coordinator | null>(null);
  const [grant, setGrant] = useState<SubscriptionGrant | null>(null);
  // Every active subscription this wallet holds (restored from localStorage), so
  // several can run concurrently and each can be switched to + charged.
  const [sessions, setSessions] = useState<PersistedSubSession[]>([]);
  // "new subscription" mode: show the service picker even while others are active.
  const [picking, setPicking] = useState(false);
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

  // Toast feedback — passkey/embedded wallets sign silently (no popup).
  const [toast, setToast] = useState<ToastState>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((kind: "pending" | "success" | "error", text: string, autoHideMs?: number) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ kind, text });
    const ms = autoHideMs ?? (kind === "pending" ? 0 : 3500);
    if (ms > 0) toastTimer.current = setTimeout(() => setToast(null), ms);
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

  // Restore a persisted active subscription so navigating back (e.g. from
  // /portfolio's "open subscriptions") lands on the LIVE subscription you can
  // charge — not a fresh "choose a service" screen. Fail-safe: any error falls
  // back to the normal flow.
  // Load one restored subscription as the CURRENT one (so it can be charged):
  // re-fetch its 402 + rebuild its ephemeral coordinator from the stored key.
  const loadSession = useCallback(
    async (sess: PersistedSubSession): Promise<boolean> => {
      const svc = subServices.find((s) => s.id === sess.serviceId);
      if (!svc) return false;
      try {
        const requirements = await fetch402(svc.resource);
        const coord = privateKeyToAccount(sess.coordinatorKey);
        coordinatorRef.current = { address: coord.address, privateKey: sess.coordinatorKey };
        setService(svc);
        setReq(requirements);
        setGrant(sess.grant);
        setCancelled(false);
        setPicking(false);
        return true;
      } catch {
        return false;
      }
    },
    [subServices]
  );

  // On mount, restore EVERY active subscription this wallet holds and auto-open the
  // most recent so you can charge it. Fail-safe: errors fall back to the fresh flow.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current || !address || subServices.length === 0) return;
    restoredRef.current = true;
    const all = loadSubSessions(address);
    setSessions(all);
    if (!grant && !cancelled && all.length > 0) {
      void loadSession(all[all.length - 1]).then((ok) => {
        if (ok) append(`Restored ${all.length} active subscription${all.length > 1 ? "s" : ""} — ready to charge`);
      });
    }
  }, [address, subServices, grant, cancelled, loadSession, append]);

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

  // Cancel = disableDelegation on the subscription root. GASLESS by default (the
  // relayer disables it, gas in USDC, no ETH), with a direct-tx fallback.
  const cancel = async () => {
    if (busy || !grant || !walletClient || !address) return;
    setBusy(true);
    showToast("pending", "Cancelling — disabling the subscription…");
    const r = await gaslessRevoke({
      walletClient,
      userAddress: address as Hex,
      context: grant.context,
      delegationManager: grant.delegationManager,
      signAuthorization: activeWallet.signAuthorization,
      log: append,
    });
    if (r.ok) {
      const cancelledHash = grant.delegationHash;
      void markGrantRevoked(cancelledHash, address); // reflect in /portfolio
      removeSubSession(cancelledHash); // this one is dead — don't restore it
      const rest = sessions.filter((s) => s.grant.delegationHash !== cancelledHash);
      setSessions(rest);
      setSubState(null);
      coordinatorRef.current = null;
      // Switch to another active subscription if one remains; else clear to picker.
      if (rest.length > 0) {
        void loadSession(rest[rest.length - 1]);
      } else {
        setCancelled(true);
        setGrant(null);
      }
      append(`Subscription cancelled ${r.viaGasless ? "gaslessly" : "on-chain"} ✓ · every future charge against this grant now reverts on-chain`);
      showToast("success", "Subscription cancelled ✓");
    } else {
      append(`Cancel failed · ${r.error}`);
      showToast("error", `Cancel failed · ${r.error}`);
    }
    setBusy(false);
  };

  // Pick a service to subscribe to — allowed even while other subscriptions are
  // active (you no longer have to cancel to switch). Enters "new subscription" mode.
  const selectService = async (svc: CatalogService) => {
    if (busy || (picking && svc.id === service?.id)) return;
    try {
      const requirements = await fetch402(svc.resource);
      setService(svc);
      setReq(requirements);
      setTierIdx(0); // reset to the seller default for the newly selected service
      setGrant(null); // show the subscribe form for the new one (actives stay in the switcher)
      setPicking(true);
      setCancelled(false);
      append(`Selected ${svc.label} · charged once ${fmtCadence(requirements.subscription?.periodSeconds)}`);
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
    showToast("pending", "Signing your subscription…");
    try {
      const coordinator = createCoordinatorAccount();
      coordinatorRef.current = coordinator;
      append(`Coordinator session account · ${shorten(coordinator.address)}`);

      const embeddedWallet = getEmbeddedConnectedWallet(wallets);
      const signerAddress = isPasskey ? activeWallet.address : (embeddedWallet?.address as Hex | undefined);
      if (signerAddress) {
        append(`Signing EIP-7702 authorization · designating ${shorten(config.eip7702Impl)}…`);
        const nonce = await publicClient.getTransactionCount({ address: signerAddress });
        setAuthorization(
          await activeWallet.signAuthorization({
            contractAddress: config.eip7702Impl,
            chainId: config.chainId,
            nonce,
          })
        );
        append("EIP-7702 authorization signed · bundled into the first charge");
      } else {
        append("External wallet can't sign EIP-7702 — sign in with email or a passkey for the full flow.");
      }

      const terms = termsFromRequirements(req, req.subscription, activeTier);
      const nowSecs = Math.floor(Date.now() / 1000);
      const expiry = noExpiry
        ? undefined
        : Math.max(nowSecs + 60, Math.floor(new Date(subExpiryAt).getTime() / 1000));
      append(
        `Signing the subscription: ${activePriceUsdc ?? service.priceUsdc} USDC → ${shorten(terms.recipient)} once ${fmtCadence(terms.periodSeconds)}` +
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
      setPicking(false);
      // Persist the session (grant + coordinator key) so the active subscription
      // survives navigation/reload, can still be charged from /portfolio, and runs
      // CONCURRENTLY with other active subscriptions.
      if (service) {
        const sess = { user: address, serviceId: service.id, coordinatorKey: coordinator.privateKey, grant: g };
        saveSubSession(sess);
        setSessions((prev) => [...prev.filter((s) => s.grant.delegationHash !== g.delegationHash), sess]);
      }
      append("Subscription approved · your signature binds merchant + amount + cadence on-chain");
      showToast("success", "Subscribed ✓ — bound to one merchant, amount + cadence");
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
      showToast("error", `Subscribe failed · ${errMsg(e)}`);
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
        // What this period's charge bought — the live Venice deliverable.
        const d = (r.data as { content?: { headline?: string; body?: string }; source?: string } | undefined);
        const deliverable = d?.content?.body ? { headline: d.content.headline, body: d.content.body, source: d.source } : null;
        patchCard(correlationId, { stage: "settled", txHash: r.settlement?.transaction ?? null, deliverable });
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

  // The active cadence tier (buyer-selected, or the seller default). Drives both
  // what's displayed and what gets signed.
  const subTiers = req?.subscription?.tiers;
  const activeTier = subTiers?.[tierIdx];
  const activePeriodSeconds = activeTier?.periodSeconds ?? req?.subscription?.periodSeconds;
  const activePriceUsdc = activeTier
    ? formatUnits(BigInt(activeTier.amountPerPeriod), 6)
    : service?.priceUsdc;
  const periodLabel = activePeriodSeconds ? fmtCadence(activePeriodSeconds) : "—";
  // The most recent Venice deliverable a charge bought (newest-first list).
  const lastDeliverable = charges.find((c) => c.stage === "settled" && c.deliverable?.body)?.deliverable ?? null;

  // The ERC-7710 binding every charge carries (same enforcer + terms each time).
  const inspectorBinding: InspectorBinding | null =
    req?.subscription && service
      ? {
          kind: "subscription",
          enforcerName: "X402SubscriptionEnforcer",
          enforcerAddr: req.subscription.enforcer,
          terms: [
            { label: "amount", value: `${activePriceUsdc ?? service.priceUsdc} USDC (exact)` },
            { label: "merchant", value: shorten(req.payTo) },
            { label: "cadence", value: `once ${periodLabel}` },
          ],
        }
      : null;

  return (
    <main className="min-h-screen">
      <Toast toast={toast} />
      {/* top bar — standalone only; the ConduitPay shell provides the header */}
      {!embedded && (
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
      )}

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

            {/* Active subscriptions switcher — run several concurrently; tap to
                switch the one you're charging, or add another. */}
            {sessions.length > 0 && (
              <div className="mt-4">
                <p className="text-[11px] uppercase tracking-wide text-conduit-muted/70">
                  Your subscriptions <span className="text-conduit-muted/50">· {sessions.length} active</span>
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {sessions.map((sess) => {
                    const svc = subServices.find((s) => s.id === sess.serviceId);
                    const on = !picking && grant?.delegationHash === sess.grant.delegationHash;
                    return (
                      <button
                        key={sess.grant.delegationHash}
                        onClick={() => void loadSession(sess)}
                        disabled={busy}
                        className={`rounded-lg border px-2.5 py-1.5 text-[12px] transition disabled:opacity-40 ${
                          on ? "border-conduit-cyan bg-conduit-cyan/10 text-white" : "border-conduit-border text-conduit-muted hover:border-conduit-cyan/40"
                        }`}
                      >
                        {svc?.label ?? sess.serviceId}
                      </button>
                    );
                  })}
                  <button
                    onClick={() => { setPicking(true); setGrant(null); setCancelled(false); }}
                    disabled={busy}
                    className={`rounded-lg border px-2.5 py-1.5 text-[12px] transition disabled:opacity-40 ${
                      picking ? "border-conduit-cyan bg-conduit-cyan/10 text-white" : "border-dashed border-conduit-border text-conduit-muted hover:border-conduit-cyan/40"
                    }`}
                  >
                    + Subscribe to another
                  </button>
                </div>
              </div>
            )}

            {/* Subscription marketplace — discovered on ERC-8004; pick one. Shown
                when adding a new subscription or when none are active yet. */}
            {subServices.length > 0 && (picking || sessions.length === 0) && (
              <div className="mt-4">
                <p className="text-[11px] uppercase tracking-wide text-conduit-muted/70">
                  Choose a service
                </p>
                <div className="mt-2 grid gap-2">
                  {subServices.map((s) => {
                    const sel = s.id === service?.id && picking;
                    const agent = subAgents.find((a) => a.id === s.id);
                    const vis = productVisual(s.id);
                    return (
                      <button
                        key={s.id}
                        onClick={() => selectService(s)}
                        disabled={busy}
                        className={`flex w-full gap-3 rounded-xl border p-3 text-left transition disabled:cursor-not-allowed ${
                          sel ? "border-conduit-cyan/60 bg-conduit-cyan/10" : "border-conduit-border/60 hover:border-conduit-cyan/40"
                        }`}
                      >
                        {/* avatar — Venice-generated product cover */}
                        {vis.img ? (
                          <Image
                            src={vis.img}
                            alt=""
                            width={44}
                            height={44}
                            className={`h-11 w-11 shrink-0 rounded-lg object-cover ring-1 ${vis.ring}`}
                          />
                        ) : (
                          <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-lg text-xl ring-1 ${vis.ring}`}>
                            {vis.glyph}
                          </span>
                        )}
                        {/* details */}
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center justify-between gap-2">
                            <span className="truncate text-[13px] font-semibold text-white">{sel ? "● " : ""}{s.label}</span>
                            <span className="mono shrink-0 text-[11px] text-white">{s.priceUsdc} USDC</span>
                          </span>
                          <span className="mt-0.5 block text-[11.5px] leading-snug text-conduit-muted line-clamp-2">{s.description}</span>
                          <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
                            <span className="mono rounded bg-conduit-violet/15 px-1.5 py-0.5 text-[9.5px] text-conduit-violet">✦ {agent?.veniceEndpoint ?? "venice"}</span>
                            <span className="mono rounded border border-conduit-border px-1.5 py-0.5 text-[9.5px] text-conduit-muted">once {fmtCadence(agent?.subscription?.periodSeconds)}</span>
                            {agent?.agentId && (
                              <span className="mono rounded border border-conduit-cyan/30 px-1.5 py-0.5 text-[9.5px] text-conduit-cyan/80">agent #{agent.agentId}</span>
                            )}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {service && req ? (
              <div className="mt-4 space-y-3">
                <div className="rounded-lg border border-conduit-border/60 p-3">
                  <p className="text-sm font-semibold text-white">{service.label}</p>
                  <p className="mt-0.5 text-[12px] text-conduit-muted">{service.description}</p>

                  {/* Buyer-selectable cadence — pick one of the seller's tiers. */}
                  {subTiers && subTiers.length > 1 && (
                    <div className="mt-3">
                      <p className="text-[11px] uppercase tracking-wide text-conduit-muted/70">Cadence</p>
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {subTiers.map((t, i) => {
                          const on = i === tierIdx;
                          return (
                            <button
                              key={t.periodSeconds}
                              type="button"
                              onClick={() => setTierIdx(i)}
                              disabled={busy || subscribed}
                              className={`rounded-lg border px-2.5 py-1.5 text-[11.5px] transition disabled:cursor-not-allowed ${
                                on ? "border-conduit-cyan bg-conduit-cyan/10 text-white" : "border-conduit-border text-conduit-muted hover:border-conduit-cyan/40"
                              }`}
                            >
                              {t.label} <span className="text-conduit-muted/70">· {formatUnits(BigInt(t.amountPerPeriod), 6)} USDC</span>
                            </button>
                          );
                        })}
                      </div>
                      {!subscribed && <p className="mt-1.5 text-[10px] text-conduit-muted/60">You sign the cadence you pick — the charge is bound to it on-chain.</p>}
                    </div>
                  )}

                  <div className="mono mt-3 space-y-1 text-[12px]">
                    <Row k="charge" v={`${activePriceUsdc ?? service.priceUsdc} USDC (exact)`} />
                    <Row k="cadence" v={`once ${periodLabel}`} />
                    <Row k="paid to" v={shorten(req.payTo)} />
                    <Row k="on-chain rule" v={shorten(req.subscription?.enforcer ?? null)} />
                  </div>
                </div>

                {!subscribed ? (
                  <>
                    <p className="text-[12px] leading-relaxed text-conduit-muted">
                      One signature. The service can charge <span className="text-white">this exact amount, once per period</span> — and nothing else.
                      Each period you get a live Venice update.
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
                        Your bounds: when it auto-expires, and the per-period gas budget — paid in USDC, never ETH.
                      </p>
                    </div>

                    <button
                      onClick={subscribe}
                      disabled={!connected || busy}
                      className="btn-primary w-full justify-center text-sm disabled:opacity-40"
                    >
                      {busy ? "Signing…" : "Subscribe"}
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
                      {busy ? "Working…" : "Cancel — gasless, no ETH"}
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

              {/* what the latest charge delivered — the Venice update */}
              {lastDeliverable?.body && (
                <div className="mt-4 rounded-lg border border-conduit-cyan/25 bg-conduit-cyan/[0.04] p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-[12px] font-semibold text-white">Latest · {lastDeliverable.headline}</span>
                    <span className="mono rounded bg-conduit-violet/15 px-1.5 py-0.5 text-[10px] text-conduit-violet">✦ Venice</span>
                  </div>
                  <p className="mt-1 whitespace-pre-line text-[12px] leading-relaxed text-conduit-muted">{lastDeliverable.body}</p>
                </div>
              )}

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
                  Already paid this period? &ldquo;Force charge again&rdquo; sends a real payment — and the
                  chain rejects it (<span className="mono">already charged this period</span>). No money moves.
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
              <span className="mono text-[11px] text-conduit-muted">a live Venice update each period</span>
            </div>
            <div className="min-h-[460px] space-y-3 px-5 py-5">
              {charges.length === 0 ? (
                <div className="pt-12 text-center">
                  <p className="mono text-sm text-conduit-muted">
                    {connected ? (subscribed ? "Charge the subscription to begin." : "Approve the subscription to begin.") : "Sign in to begin."}
                  </p>
                  <p className="mx-auto mt-3 max-w-md text-[12px] leading-relaxed text-conduit-muted/70">
                    Each period buys a live Venice update — and your signed rule lets exactly one
                    charge through per period; a second in the same period is rejected on-chain.
                  </p>
                </div>
              ) : (
                <>
                  <p className="text-[12px] leading-relaxed text-conduit-muted">
                    Each charge is bounded by your signed rule — exact amount, one merchant, once per
                    period — and delivers a live Venice update. Inspect any card for the on-chain proof.
                  </p>
                  {charges.map((c) => (
                    <ChargeCardView
                      key={c.correlationId}
                      card={c}
                      priceUsdc={service?.priceUsdc ?? "—"}
                      binding={inspectorBinding}
                      productName={service?.label}
                      embedded={embedded}
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
    { label: "Amount", old: "Whatever they charge", conduit: "Exact, fixed by your signature" },
    { label: "Frequency", old: "Whenever they decide", conduit: "Once per period — a 2nd reverts" },
    { label: "If it's hijacked", old: "Can redirect or overcharge", conduit: "Can't — your rule forbids it" },
    { label: "Cancelling", old: "Email support, then wait", conduit: "Revoke yourself, instantly — gasless" },
  ];
  const steps: [string, string][] = [
    ["Sign once", "One signature binds this service · the exact amount · the cadence — to your own account."],
    ["Charged each period", "It pulls exactly that amount when the period rolls. A 2nd pull in the same period reverts on-chain."],
    ["Cancel anytime", "Disable it and every future charge reverts — gasless, no ETH."],
  ];
  return (
    <section className="panel reveal mx-auto mt-6 max-w-7xl overflow-hidden p-0">
      {/* headline + 3 steps */}
      <div className="p-6 sm:p-8">
        <h1 className="text-2xl font-semibold tracking-tight text-white sm:text-[28px]">
          Subscribe once. Charged exactly the same, every period.
        </h1>
        <p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-conduit-muted">
          You sign one permission. The service charges a fixed amount each period — it can&apos;t overcharge,
          bill twice in a period, or change who gets paid. Cancel anytime, gasless.
        </p>
        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          {steps.map(([t, b], i) => (
            <div key={t} className="rounded-xl border border-conduit-border/60 p-3.5">
              <div className="mono text-[11px] text-conduit-cyan">0{i + 1}</div>
              <div className="mt-1 text-sm font-semibold text-white">{t}</div>
              <div className="mt-1 text-[12px] leading-relaxed text-conduit-muted">{b}</div>
            </div>
          ))}
        </div>
      </div>
      {/* Card-on-file vs Conduit comparison — desktop only; on mobile it's a long
          scroll between the user and the services, so we hide it there. */}
      <div className="hidden border-t border-conduit-border/60 md:grid md:grid-cols-2">
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

/** Classify a subscription deliverable → the matching Pay action, so the loop
 *  closes: yield/DeFi intel hands off to a YIELD deposit; everything else (token /
 *  market / alpha intel) hands off to a SWAP. Returns the Pay prompt to prefill. */
function handoffIntent(productName?: string, headline?: string, body?: string): { label: string; intent: string } {
  const hay = `${productName ?? ""} ${headline ?? ""} ${body ?? ""}`.toLowerCase();
  const isYield = /\b(yield|defi|lend|lending|deposit|supply|apy|apr|aave|seamless|morpho|moonwell)\b/.test(hay);
  if (isYield) {
    return { label: "Deposit into the best yield →", intent: "Deposit 50 USDC into the best yield venue across my approved lending pools" };
  }
  return { label: "Act on this in Pay →", intent: "Swap 25 USDC into the best token from my approved set" };
}

function ChargeCardView({
  card,
  priceUsdc,
  binding,
  productName,
  embedded,
}: {
  card: ChargeCard;
  priceUsdc: string;
  binding: InspectorBinding | null;
  productName?: string;
  embedded?: boolean;
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

      {/* what this period bought — the live Venice deliverable */}
      {done && card.deliverable?.body && (
        <div className="mt-3 rounded-lg border border-conduit-cyan/25 bg-conduit-cyan/[0.04] p-3">
          <div className="flex items-center justify-between">
            <span className="text-[12px] font-semibold text-white">{card.deliverable.headline ?? "This period's update"}</span>
            {card.deliverable.source?.startsWith("venice") && (
              <span className="mono rounded bg-conduit-violet/15 px-1.5 py-0.5 text-[10px] text-conduit-violet">✦ Venice</span>
            )}
          </div>
          <div className="mt-1.5 whitespace-pre-line text-[12.5px] leading-relaxed text-conduit-muted">{card.deliverable.body}</div>
          {/* Close the loop: this period's intel → a one-tap, bounded action in Pay. */}
          {(() => {
            const { label, intent } = handoffIntent(productName, card.deliverable?.headline, card.deliverable?.body);
            const href = `${embedded ? "/app/pay" : "/demo"}?intent=${encodeURIComponent(intent)}`;
            return (
              <Link
                href={href}
                className="mono mt-2.5 inline-flex items-center gap-1 rounded-md border border-conduit-cyan/40 bg-conduit-cyan/10 px-2.5 py-1 text-[11px] text-conduit-cyan transition-colors hover:bg-conduit-cyan/20"
              >
                {label}
              </Link>
            );
          })()}
        </div>
      )}

      {binding && (
        <>
          <button
            onClick={() => setOpen((o) => !o)}
            className="mono mt-2 text-[11px] text-conduit-muted underline-offset-4 hover:text-conduit-cyan"
          >
            {open ? "▾ hide details" : "▸ inspect the on-chain rule"}
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

/** A clean cadence phrase: 60→"a minute", 86400→"a day", 604800→"a week";
 *  odd values → "every 90s" — so "once {fmtCadence}" always reads naturally. */
function fmtCadence(s?: number): string {
  if (!s) return "—";
  const named: Record<number, string> = { 60: "a minute", 3600: "an hour", 86_400: "a day", 604_800: "a week", 2_592_000: "a month" };
  return named[s] ?? `every ${fmtDuration(s)}`;
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
  // Walk the whole error + cause chain and collect every message-like field, so an
  // opaque top-level wrapper (e.g. "an internal error occurred") doesn't hide the
  // real reason buried in a nested cause / details / metaMessages.
  const found: string[] = [];
  let cur: unknown = e;
  for (let depth = 0; cur && typeof cur === "object" && depth < 6; depth++) {
    const o = cur as Record<string, unknown>;
    for (const k of ["shortMessage", "details", "message"] as const) {
      const v = o[k];
      if (typeof v === "string" && v.trim()) found.push(v.trim());
    }
    const data = o.data as Record<string, unknown> | undefined;
    if (typeof data?.message === "string" && data.message.trim()) found.push(data.message.trim());
    if (typeof o.name === "string" && o.name && o.name !== "Error") found.push(`(${o.name}${o.code != null ? ` ${String(o.code)}` : ""})`);
    cur = o.cause;
  }
  // Prefer the most SPECIFIC line — skip the generic "internal error" wrapper if a
  // more concrete message exists anywhere in the chain.
  const generic = /^an?\s+(internal|unknown)\s+error/i;
  const specific = found.find((m) => !generic.test(m));
  if (specific) return found.length > 1 ? `${specific} ${found.filter((m) => /^\(/.test(m)).join(" ")}`.trim() : specific;
  if (found.length) return found.join(" · ");
  return e instanceof Error ? e.message : String(e);
}

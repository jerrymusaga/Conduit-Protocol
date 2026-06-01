"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatUnits } from "viem";
import { useAccount, useWalletClient } from "wagmi";
import {
  usePrivy,
  useLogin,
  useSign7702Authorization,
  useWallets,
  getEmbeddedConnectedWallet,
} from "@privy-io/react-auth";
import { useSetActiveWallet } from "@privy-io/wagmi";
import {
  BUDGET,
  PERIOD_OPTIONS,
  periodLabel,
  createCoordinatorAccount,
  grantBudget,
  type Coordinator,
  type GrantResult,
} from "@/lib/grant";
import {
  runCampaign,
  attemptRogue,
  type A2AMode,
  type PlannedItem,
  type RogueKind,
} from "@/lib/coordinator";
import type { Hex } from "viem";
import type { Eip7702Authorization } from "@/lib/payment";
import { useFacilitatorEvents } from "@/lib/useFacilitatorEvents";
import { config } from "@/lib/config";
import { publicClient } from "@/lib/chain";

/* ===========================================================================
   Conduit — facilitator operations console.
   Conduit is the star: a live feed of x402 payments flowing through the
   facilitator (request → permission → settle → released), each authorized
   against ONE erc7715 permission, multiple agents draining one budget.
   Client coordinator narrates each card instantly; the facilitator's SSE
   stream annotates/confirms them (smoothest UX).
   =========================================================================== */

type CardStage = "queued" | "requested" | "allowed" | "denied" | "settling" | "settled" | "failed";

interface FeedCard {
  correlationId: string;
  service: string;
  label: string;
  agent: string;
  priceUsdc: string;
  rationale: string;
  stage: CardStage;
  reason?: string | null;
  txHash?: string | null;
}

const STAGE_LABEL: Record<CardStage, string> = {
  queued: "queued",
  requested: "x402 request",
  allowed: "permission ✓",
  denied: "DENIED",
  settling: "settling…",
  settled: "settled ✓",
  failed: "failed",
};

// --- session persistence (survives a page refresh) -------------------------
// The grant + ephemeral coordinator key live only in React state, so a refresh
// wipes them even though Privy keeps you signed in. Persist them to
// sessionStorage (bigint-safe), keyed to the signed-in address, and rehydrate
// on mount if it matches and the grant hasn't expired.

const SESSION_KEY = "conduit.session.v1";

interface PersistedSession {
  address: string;
  coordinator: Coordinator;
  grant: Omit<GrantResult, "periodAmount"> & { periodAmount: string };
  authorization: Eip7702Authorization | null;
  spent: number;
}

function saveSession(s: {
  address: string;
  coordinator: Coordinator;
  grant: GrantResult;
  authorization: Eip7702Authorization | null;
  spent: number;
}) {
  try {
    const data: PersistedSession = {
      address: s.address,
      coordinator: s.coordinator,
      grant: { ...s.grant, periodAmount: s.grant.periodAmount.toString() },
      authorization: s.authorization,
      spent: s.spent,
    };
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(data));
  } catch {
    /* storage unavailable — non-fatal */
  }
}

function clearSession() {
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* noop */
  }
}

/** Restore a session iff it matches `address` and the grant hasn't expired. */
function loadSession(address: string): {
  coordinator: Coordinator;
  grant: GrantResult;
  authorization: Eip7702Authorization | null;
  spent: number;
} | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as PersistedSession;
    if (d.address.toLowerCase() !== address.toLowerCase()) return null;
    if (d.grant.expiry <= Math.floor(Date.now() / 1000)) {
      clearSession();
      return null;
    }
    return {
      coordinator: d.coordinator,
      grant: { ...d.grant, periodAmount: BigInt(d.grant.periodAmount) },
      authorization: d.authorization,
      spent: d.spent,
    };
  } catch {
    return null;
  }
}

const now = () => new Date().toLocaleTimeString("en-US", { hour12: false });

export default function DemoPage() {
  // Privy (auth) + wagmi (wallet client).
  const { ready, authenticated, logout } = usePrivy();
  const { login } = useLogin();
  const { signAuthorization } = useSign7702Authorization();
  const { wallets } = useWallets();
  const { setActiveWallet } = useSetActiveWallet();
  const { address, isConnected } = useAccount();
  const { data: walletClient } = useWalletClient({ chainId: config.chainId });
  const connected = ready && authenticated && isConnected && !!address;

  // Bind the embedded Ethereum wallet to wagmi after login.
  useEffect(() => {
    if (!authenticated || wallets.length === 0) return;
    const embedded = getEmbeddedConnectedWallet(wallets);
    const ethExternal = wallets.find((w) => w.chainId?.startsWith("eip155:"));
    const target = embedded ?? ethExternal ?? wallets[0];
    if (!target) return;
    if (address && address.toLowerCase() === target.address.toLowerCase()) return;
    void setActiveWallet(target);
  }, [authenticated, wallets, address, setActiveWallet]);

  // Grant / permission state.
  const [granted, setGranted] = useState(false);
  const [grantResult, setGrantResult] = useState<GrantResult | null>(null);
  const [amountInput, setAmountInput] = useState<string>(BUDGET.periodAmountUsdc);
  const [periodSeconds, setPeriodSeconds] = useState<number>(BUDGET.periodDuration);
  const [authorization, setAuthorization] = useState<Eip7702Authorization | null>(null);
  const coordinatorRef = useRef<Coordinator | null>(null);

  // Console state.
  const [prompt, setPrompt] = useState("Launch my new product: a visual, a tagline, and competitor research.");
  const [mode, setMode] = useState<A2AMode>("a2a");
  const [busy, setBusy] = useState(false);
  const [spent, setSpent] = useState(0); // micro-USDC settled
  const [cards, setCards] = useState<FeedCard[]>([]);
  const [log, setLog] = useState<{ t: string; text: string }[]>([]);
  // The last settled payment (exact payload + path) — fuel for a REAL replay.
  const lastSettledRef = useRef<{ payload: unknown; resourcePath: string } | null>(null);
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  const [copied, setCopied] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);

  // Live SSE feed from the facilitator (server-truth annotation).
  const { events, connected: sseConnected } = useFacilitatorEvents(connected);
  const seenEvents = useRef(new Set<string>());
  const rehydrated = useRef(false);

  const CAP = grantResult ? Number(grantResult.periodAmount) : 100_000;
  const pct = Math.min(100, (spent / CAP) * 100);
  const remaining = grantResult ? Math.max(0, grantResult.expiry - nowSec) : null;
  const expiryText =
    remaining == null
      ? "—"
      : `${String(Math.floor(remaining / 60)).padStart(2, "0")}:${String(remaining % 60).padStart(2, "0")}`;
  const displayAmount = grantResult ? grantResult.periodAmountUsdc : amountInput;
  const displayPeriod = grantResult ? grantResult.periodLabel : periodLabel(periodSeconds);

  const append = useCallback((text: string) => {
    setLog((l) => [...l, { t: now(), text }]);
    requestAnimationFrame(() => logEndRef.current?.scrollIntoView({ behavior: "smooth" }));
  }, []);

  // Rehydrate a persisted session on (re)connect so a refresh doesn't wipe the
  // grant + coordinator. Only restores if the address matches + grant is live.
  useEffect(() => {
    if (rehydrated.current || !connected || !address || granted) return;
    const s = loadSession(address);
    if (s) {
      coordinatorRef.current = s.coordinator;
      setGrantResult(s.grant);
      setAuthorization(s.authorization);
      setSpent(s.spent);
      setGranted(true);
      rehydrated.current = true;
      append("Restored your active grant from this session.");
    }
  }, [connected, address, granted, append]);

  // Tick the expiry countdown.
  useEffect(() => {
    if (!grantResult) return;
    const id = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, [grantResult]);

  // Keep the persisted session in sync as spend accrues / the 7702 auth is
  // consumed, so a mid-run refresh restores accurate budget + auth state.
  useEffect(() => {
    if (!granted || !grantResult || !address || !coordinatorRef.current) return;
    saveSession({
      address,
      coordinator: coordinatorRef.current,
      grant: grantResult,
      authorization,
      spent,
    });
  }, [granted, grantResult, address, authorization, spent]);

  // Annotate feed cards from the facilitator's SSE stream (server-truth). The
  // client narration sets the optimistic stage; SSE confirms permission/settle.
  useEffect(() => {
    for (const ev of events) {
      if (seenEvents.current.has(ev.id)) continue;
      seenEvents.current.add(ev.id);
      if (!ev.correlationId) continue;
      setCards((cs) =>
        cs.map((c) => {
          if (c.correlationId !== ev.correlationId) return c;
          if (ev.stage === "permission") {
            return ev.allowed
              ? { ...c, stage: c.stage === "settled" ? c.stage : "allowed" }
              : { ...c, stage: "denied", reason: ev.reason };
          }
          if (ev.stage === "settle") return { ...c, stage: "settling", txHash: ev.txHash };
          if (ev.stage === "settled") {
            return ev.status === "confirmed"
              ? { ...c, stage: "settled", txHash: ev.txHash }
              : { ...c, stage: "failed", reason: ev.reason };
          }
          return c;
        })
      );
    }
  }, [events]);

  const copyAddress = useCallback(() => {
    if (!address) return;
    navigator.clipboard?.writeText(address).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [address]);

  const setCardStage = (correlationId: string, patch: Partial<FeedCard>) =>
    setCards((cs) => cs.map((c) => (c.correlationId === correlationId ? { ...c, ...patch } : c)));

  // --- actions -----------------------------------------------------------

  const connect = async () => {
    if (busy) return;
    append("Opening sign-in…");
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
      setGranted(false);
      setGrantResult(null);
      setAuthorization(null);
      setSpent(0);
      setCards([]);
      setLog([]);
      rehydrated.current = false;
      clearSession();
    }
  };

  // Grant: coordinator EOA + 7702 auth (embedded wallet) + root delegation.
  const grant = async () => {
    if (busy) return;
    if (!walletClient || !address) {
      append(`Waiting for wallet to bind… (wallets=${wallets.length})`);
      return;
    }
    setBusy(true);
    try {
      append("Creating coordinator session account…");
      const coordinator = createCoordinatorAccount();
      coordinatorRef.current = coordinator;
      append(`Coordinator account · ${shorten(coordinator.address)}`);

      let signedAuth: Eip7702Authorization | null = null;
      const embeddedWallet = getEmbeddedConnectedWallet(wallets);
      if (embeddedWallet) {
        append(`Signing EIP-7702 authorization · designating ${shorten(config.eip7702Impl)}…`);
        const nonce = await publicClient.getTransactionCount({
          address: embeddedWallet.address as `0x${string}`,
        });
        const auth = await signAuthorization(
          { contractAddress: config.eip7702Impl, chainId: config.chainId, nonce },
          { address: embeddedWallet.address }
        );
        signedAuth = {
          chainId: auth.chainId,
          address: auth.address as `0x${string}`,
          nonce: auth.nonce,
          r: auth.r,
          s: auth.s,
          yParity: (auth.yParity === 1 ? 1 : 0) as 0 | 1,
        };
        setAuthorization(signedAuth);
        append("EIP-7702 authorization signed · bundled into the first redeem");
      } else {
        append("External wallet can't sign EIP-7702 — sign in with email/GitHub for the full flow.");
      }

      append(`Requesting permission: up to ${amountInput} USDC / ${periodLabel(periodSeconds)}…`);
      const result = await grantBudget({
        walletClient,
        userAddress: address,
        coordinator,
        amountUsdc: amountInput,
        periodDuration: periodSeconds,
      });
      setGrantResult(result);
      setAuthorization(signedAuth);
      setGranted(true);
      // The session-sync effect persists grant+coordinator+auth+spent so a
      // refresh restores the active session (survives reload).
      append("Permission granted · the coordinator holds the root policy");
    } catch (e) {
      console.error("[conduit] grant failed →", e);
      append(`Grant failed · ${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  };

  // Run the prompt: coordinator plans, then pays each service through Conduit.
  const run = async () => {
    if (busy || !granted || !grantResult || !coordinatorRef.current) return;
    setBusy(true);
    setCards([]);
    try {
      await runCampaign({
        prompt,
        grant: grantResult,
        coordinator: coordinatorRef.current,
        mode,
        authorization,
        hooks: {
          log: append,
          onPlan: (items: PlannedItem[]) => {
            setCards(
              items.map((i) => ({
                correlationId: i.correlationId,
                service: i.service.id,
                label: i.service.label,
                agent: i.agent,
                priceUsdc: i.service.priceUsdc,
                rationale: i.rationale,
                stage: "queued",
              }))
            );
          },
          onPayStart: (cid) => setCardStage(cid, { stage: "requested" }),
          onResult: (r) => {
            if (r.ok) {
              setSpent((s) => s + Number(r.amount));
              // Stash the exact settled payload to fuel a real replay attempt.
              if (r.settledPayload && r.resourcePath) {
                lastSettledRef.current = {
                  payload: r.settledPayload,
                  resourcePath: r.resourcePath,
                };
              }
              setCardStage(r.correlationId, {
                stage: "settled",
                txHash: r.txHash ?? null,
              });
            } else {
              setCardStage(r.correlationId, { stage: "denied", reason: r.error });
            }
          },
        },
      });
      // Clear the auth after the first run consumed it for designation.
      setAuthorization(null);
    } catch (e) {
      append(`Run failed · ${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  };

  // The compromised-agent beat: submit a real malicious payment and let Conduit
  // reject it on-chain. Appends a rogue card that goes magenta/denied.
  const tryRogue = async (kind: RogueKind) => {
    if (busy || !granted || !grantResult || !coordinatorRef.current) return;
    if (kind === "replay" && !lastSettledRef.current) {
      append("Run a successful payment first, then Replay can re-submit it.");
      return;
    }
    setBusy(true);
    const correlationId = crypto.randomUUID();
    const ROGUE_LABEL: Record<RogueKind, string> = {
      redirect: "Redirect funds",
      overspend: "Overspend",
      replay: "Replay",
    };
    const ROGUE_WHY: Record<RogueKind, string> = {
      redirect: "A hijacked agent tries to send the payment to its OWN address.",
      overspend: "A hijacked agent tries to pay far more than the bound amount.",
      replay: "A hijacked agent replays an already-used payment intent.",
    };
    // Add the rogue card immediately (red-tinted, requesting).
    setCards((cs) => [
      ...cs,
      {
        correlationId,
        service: "rogue",
        label: ROGUE_LABEL[kind],
        agent: "rogue",
        priceUsdc: "—",
        rationale: ROGUE_WHY[kind],
        stage: "requested",
      },
    ]);
    try {
      const r = await attemptRogue({
        kind,
        grant: grantResult,
        coordinator: coordinatorRef.current,
        priorSettled: lastSettledRef.current ?? undefined,
        hooks: {
          log: append,
          // Map the attempt onto OUR card (attemptRogue uses its own id).
          onPayStart: () => setCardStage(correlationId, { stage: "requested" }),
        },
      });
      // Real on-chain rejection (the happy path for this button).
      setCardStage(correlationId, {
        stage: r.ok ? "settled" : "denied",
        reason: r.ok ? null : r.error,
        txHash: r.txHash ?? null,
      });
    } catch (e) {
      setCardStage(correlationId, { stage: "denied", reason: errMsg(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="min-h-screen">
      {/* top bar */}
      <div className="border-b border-conduit-border/60">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <Link href="/" className="flex items-center gap-2.5">
            <Image src="/images/conduit-logo.png" alt="Conduit" width={28} height={28} className="h-7 w-7" />
            <span className="font-semibold tracking-tight">Conduit</span>
            <span className="mono ml-2 rounded-md border border-conduit-border px-2 py-0.5 text-[11px] text-conduit-muted">
              facilitator console
            </span>
          </Link>
          <div className="flex items-center gap-3">
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
              <div className="flex items-center gap-2">
                <button
                  onClick={copyAddress}
                  title={`${address} · click to copy`}
                  className="mono rounded-lg border border-conduit-border px-3 py-1.5 text-xs text-conduit-cyan transition-colors hover:border-conduit-cyan/50"
                >
                  {copied ? "copied ✓" : `${shorten(address)} · Base Sepolia · copy`}
                </button>
                <button
                  onClick={disconnect}
                  disabled={busy}
                  className="text-xs text-conduit-muted underline-offset-4 hover:text-white hover:underline disabled:opacity-40"
                >
                  sign out
                </button>
              </div>
            ) : (
              <button
                onClick={connect}
                disabled={!ready || busy}
                className="btn-primary text-sm disabled:opacity-40"
              >
                {ready ? "Sign in" : "Loading…"}
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="mx-auto grid max-w-7xl gap-6 px-6 py-8 lg:grid-cols-12">
        {/* LEFT: prompt + permission + budget */}
        <div className="space-y-6 lg:col-span-3">
          {/* Prompt */}
          <section className="panel p-6">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-conduit-muted">
              Prompt
            </h2>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              disabled={busy}
              rows={3}
              className="mono mt-3 w-full resize-none rounded-lg border border-conduit-border bg-transparent px-3 py-2 text-[13px] text-white outline-none focus:border-conduit-cyan disabled:opacity-40"
            />
            <div className="mt-3 flex items-center gap-2 text-xs">
              <span className="text-conduit-muted">A2A:</span>
              <button
                onClick={() => setMode("a2a")}
                disabled={busy}
                className={`mono rounded-md px-2 py-1 ${mode === "a2a" ? "bg-conduit-cyan/15 text-conduit-cyan" : "border border-conduit-border text-conduit-muted"}`}
              >
                3-hop sub-agents
              </button>
              <button
                onClick={() => setMode("looped")}
                disabled={busy}
                className={`mono rounded-md px-2 py-1 ${mode === "looped" ? "bg-conduit-cyan/15 text-conduit-cyan" : "border border-conduit-border text-conduit-muted"}`}
              >
                looped
              </button>
            </div>
            <button
              onClick={run}
              disabled={!granted || busy}
              className="btn-primary mt-4 w-full justify-center text-sm disabled:opacity-40"
            >
              {busy ? "Running…" : "Run"}
            </button>

            {/* The compromised-agent beat — real on-chain rejections. */}
            <div className="mt-5 border-t border-conduit-border/60 pt-4">
              <p className="text-[11px] uppercase tracking-wide text-conduit-muted">
                Simulate a hijacked agent
              </p>
              <p className="mt-1 text-[11px] leading-relaxed text-conduit-muted/70">
                Conduit rejects each one on-chain — the budget can&apos;t be misused.
              </p>
              <div className="mt-2.5 flex flex-wrap gap-2">
                {(["redirect", "overspend", "replay"] as const).map((k) => (
                  <button
                    key={k}
                    onClick={() => tryRogue(k)}
                    disabled={!granted || busy}
                    className="rounded-lg border border-conduit-magenta/40 px-2.5 py-1.5 text-xs font-medium text-conduit-magenta transition-colors hover:bg-conduit-magenta/10 disabled:opacity-40"
                  >
                    {k === "redirect" ? "Redirect funds" : k === "overspend" ? "Overspend" : "Replay"}
                  </button>
                ))}
              </div>
            </div>
          </section>

          {/* Permission */}
          <section className="panel p-6">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-conduit-muted">
                Permission
              </h2>
              <span
                className={`mono rounded-md px-2 py-0.5 text-[11px] ${granted ? "bg-conduit-cyan/15 text-conduit-cyan" : "border border-conduit-border text-conduit-muted"}`}
              >
                {granted ? "active" : "not granted"}
              </span>
            </div>

            {!granted ? (
              <div className="mt-4 space-y-3">
                <p className="text-[13px] leading-relaxed text-conduit-muted">
                  Authorize an agent budget — erc7715, single-use per request, expires after one period.
                </p>
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-white">up to</span>
                  <input
                    type="number" min="0" step="0.01" inputMode="decimal"
                    value={amountInput}
                    onChange={(e) => setAmountInput(e.target.value)}
                    disabled={!connected || busy}
                    className="mono w-20 rounded-lg border border-conduit-border bg-transparent px-2 py-1.5 text-white outline-none focus:border-conduit-cyan disabled:opacity-40"
                  />
                  <span className="text-white">/</span>
                  <select
                    value={periodSeconds}
                    onChange={(e) => setPeriodSeconds(Number(e.target.value))}
                    disabled={!connected || busy}
                    className="mono rounded-lg border border-conduit-border bg-conduit-panel px-2 py-1.5 text-white outline-none focus:border-conduit-cyan disabled:opacity-40"
                  >
                    {PERIOD_OPTIONS.map((o) => (
                      <option key={o.seconds} value={o.seconds} className="bg-conduit-panel">
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  onClick={grant}
                  disabled={!connected || busy}
                  className="btn-primary mt-1 w-full justify-center text-sm disabled:opacity-40"
                >
                  Grant permission
                </button>
              </div>
            ) : (
              <p className="mt-4 text-[13px] leading-relaxed text-conduit-muted">
                Authorizing{" "}
                <span className="font-semibold text-white">
                  up to {displayAmount} USDC / {displayPeriod}
                </span>
                . Expires in <span className="mono text-conduit-cyan">{expiryText}</span>.
              </p>
            )}

            {/* budget meter */}
            <div className="mt-5">
              <div className="flex justify-between text-xs text-conduit-muted">
                <span>spent</span>
                <span className="mono">
                  {(spent / 1e6).toFixed(2)} / {displayAmount} USDC
                </span>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/5">
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{ width: `${pct}%`, background: "linear-gradient(90deg,#00E5FF,#7C3AED,#EC4899)" }}
                />
              </div>
              <div className="mt-1 text-right text-[11px] text-conduit-muted">
                remaining{" "}
                <span className="mono text-white">
                  {((CAP - spent) / 1e6).toFixed(2)} USDC
                </span>
              </div>
            </div>
          </section>
        </div>

        {/* CENTER: the live event feed — the star */}
        <div className="lg:col-span-6">
          <section className="panel p-0">
            <div className="flex items-center justify-between border-b border-conduit-border/60 px-5 py-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-conduit-muted">
                Live payment feed
              </h2>
              <span className="mono text-[11px] text-conduit-muted">
                via Conduit facilitator · erc7710
              </span>
            </div>
            <div className="min-h-[460px] space-y-3 px-5 py-5">
              {cards.length === 0 ? (
                <div className="pt-12 text-center">
                  <p className="mono text-sm text-conduit-muted">
                    {connected
                      ? granted
                        ? "Enter a prompt and hit Run."
                        : "Grant a permission to begin."
                      : "Sign in to begin."}
                  </p>
                  <p className="mx-auto mt-3 max-w-md text-[12px] leading-relaxed text-conduit-muted/70">
                    Each agent that needs a paid service hits a paywall, asks Conduit
                    to authorize the payment against your one permission, and Conduit
                    settles it on-chain — or blocks it if it breaks the rules.
                  </p>
                </div>
              ) : (
                <>
                  <p className="text-[12px] leading-relaxed text-conduit-muted">
                    Each card is one agent <span className="text-white">paying another agent</span> for a
                    service. Watch it flow
                    <span className="text-conduit-cyan"> 402 request → permission → settle → delivered</span>,
                    all authorized + settled by Conduit against your single budget.
                  </p>
                  {cards.map((c) => <PaymentCard key={c.correlationId} card={c} />)}
                </>
              )}
            </div>
          </section>
        </div>

        {/* RIGHT: activity log */}
        <div className="lg:col-span-3">
          <section className="panel p-0">
            <div className="border-b border-conduit-border/60 px-5 py-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-conduit-muted">
                Activity
              </h2>
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

// --- payment card ----------------------------------------------------------

// Plain-English narration of what Conduit is doing at each stage.
function caption(card: FeedCard): { text: string; tone: "muted" | "work" | "ok" | "bad" } {
  const price = `${card.priceUsdc} USDC`;
  const isRogue = card.agent === "rogue";
  if (isRogue && (card.stage === "requested" || card.stage === "settling")) {
    return { text: "Hijacked agent submitting a malicious payment to Conduit…", tone: "work" };
  }
  if (isRogue && card.stage === "denied") {
    return { text: "Conduit BLOCKED it on-chain — the caveat rejected it. No money moved. ✓", tone: "bad" };
  }
  switch (card.stage) {
    case "queued":
      return { text: `${card.agent} agent queued — needs to pay ${price} for this`, tone: "muted" };
    case "requested":
      return { text: `Hit a paywall (HTTP 402). Asking Conduit to authorize ${price}…`, tone: "work" };
    case "allowed":
      return { text: `Conduit checked the permission — within budget, bound to this exact request ✓`, tone: "ok" };
    case "settling":
      return { text: `Authorized. Settling on-chain via Conduit's relayer…`, tone: "work" };
    case "settled":
      return { text: `Paid ${price} on-chain. Service unlocked and delivered.`, tone: "ok" };
    case "denied":
      return { text: `Conduit BLOCKED this payment — it broke the permission. No money moved.`, tone: "bad" };
    case "failed":
      return { text: `Settlement failed on-chain. No money moved.`, tone: "bad" };
  }
}

const TONE: Record<"muted" | "work" | "ok" | "bad", string> = {
  muted: "text-conduit-muted",
  work: "text-conduit-violet",
  ok: "text-conduit-cyan",
  bad: "text-conduit-magenta",
};

function PaymentCard({ card }: { card: FeedCard }) {
  const denied = card.stage === "denied" || card.stage === "failed";
  const done = card.stage === "settled";
  const working = card.stage === "requested" || card.stage === "settling";
  const accent = denied ? "#EC4899" : done ? "#00E5FF" : "#7C3AED";
  const cap = caption(card);

  return (
    <div
      className="reveal rounded-xl border px-4 py-3.5 transition-all"
      style={{ borderColor: `${accent}55`, background: `${accent}0a` }}
    >
      {/* header: which agent pays which agent, for how much */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span
            className={`h-2.5 w-2.5 rounded-full ${working ? "animate-pulse" : ""}`}
            style={{ background: accent, boxShadow: `0 0 10px ${accent}` }}
          />
          {card.agent === "rogue" ? (
            <span className="text-sm font-semibold text-conduit-magenta">
              {card.label} · rogue agent
            </span>
          ) : (
            <span className="mono flex items-center gap-1.5 text-[12px]">
              <span className="text-conduit-muted">{card.agent} agent</span>
              <span className="text-conduit-muted/40">pays →</span>
              <span className="font-semibold text-white">{card.label}</span>
            </span>
          )}
        </div>
        <span className="mono text-xs font-semibold text-white">{card.priceUsdc} USDC</span>
      </div>

      {/* why the agent wants it (the coordinator's reasoning) */}
      <p className="mt-1.5 text-[12px] italic text-conduit-muted">“{card.rationale}”</p>

      {/* the 4-stage pipeline, with readable labels */}
      <div className="mono mt-3 flex items-center gap-1.5 text-[11px]">
        <Step on={["requested", "allowed", "settling", "settled"].includes(card.stage)} label="402 request" />
        <Arrow />
        <Step
          on={["allowed", "settling", "settled"].includes(card.stage)}
          bad={denied}
          label={denied ? "permission ✗" : "permission ✓"}
        />
        <Arrow />
        <Step on={["settling", "settled"].includes(card.stage)} label="settle" />
        <Arrow />
        <Step on={done} label="delivered" />
      </div>

      {/* plain-English caption of the current step */}
      <p className={`mt-2.5 text-[12px] leading-relaxed ${TONE[cap.tone]}`}>{cap.text}</p>

      {card.reason && (
        <p className="mono mt-1.5 text-[11px] text-conduit-magenta/80">
          revert reason: {card.reason}
        </p>
      )}
      {card.txHash && card.txHash.startsWith("0x") && (
        <a
          href={`${config.explorerUrl}/tx/${card.txHash}`}
          target="_blank"
          rel="noopener noreferrer"
          className="mono mt-2 inline-flex items-center gap-1 text-[11px] text-conduit-cyan underline-offset-4 hover:underline"
        >
          view settlement tx {shorten(card.txHash)} ↗
        </a>
      )}
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

// --- helpers ---------------------------------------------------------------

function shorten(addr: string | null): string {
  if (!addr) return "—";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
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

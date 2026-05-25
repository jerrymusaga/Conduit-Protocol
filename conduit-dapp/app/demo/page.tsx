"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { WalletClient } from "viem";
import type { MetaMaskSmartAccount } from "@metamask/smart-accounts-kit";
import { connectWallet } from "@/lib/wallet";
import {
  BUDGET,
  PERIOD_OPTIONS,
  periodLabel,
  createCoordinatorAccount,
  grantBudget,
  type GrantResult,
} from "@/lib/erc7715";
import { config } from "@/lib/config";

/* ===========================================================================
   Conduit demo.
   The flow, the panels, and every judging-lens beat are here and animated.
   WIRED (real): Connect (viem + MetaMask) and Grant (ERC-7715 erc20-token-
   periodic; EIP-7702 upgrade handled by MetaMask).
   Still MOCK (next): Run flow (redelegation + X402ReceiptEnforcer + facilitator
   /verify + /settle), break-it buttons, kill-root (disableDelegation).
   =========================================================================== */

type LogKind = "info" | "agent" | "pay" | "ok" | "reject";
interface LogLine {
  t: string;
  kind: LogKind;
  text: string;
}

type AgentState = "idle" | "active" | "done" | "dark";
interface Agent {
  id: "coordinator" | "discover" | "execute" | "claim";
  label: string;
  scope: string;
  accent: string;
  state: AgentState;
}

const INITIAL_AGENTS: Agent[] = [
  { id: "coordinator", label: "Coordinator", scope: "root policy · 0.10 USDC/hr", accent: "#ffffff", state: "idle" },
  { id: "discover", label: "discover", scope: "read 402 · no spend", accent: "#00E5FF", state: "idle" },
  { id: "execute", label: "execute", scope: "pay 1 bound intent", accent: "#7C3AED", state: "idle" },
  { id: "claim", label: "claim", scope: "fetch the asset", accent: "#EC4899", state: "idle" },
];

const now = () =>
  new Date().toLocaleTimeString("en-US", { hour12: false });

export default function DemoPage() {
  const [connected, setConnected] = useState(false);
  const [account, setAccount] = useState<`0x${string}` | null>(null);
  const [granted, setGranted] = useState(false);
  const [grantResult, setGrantResult] = useState<GrantResult | null>(null);
  const [amountInput, setAmountInput] = useState<string>(BUDGET.periodAmountUsdc);
  const [periodSeconds, setPeriodSeconds] = useState<number>(BUDGET.periodDuration);
  const [revoked, setRevoked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [spent, setSpent] = useState(0); // micro-USDC used this period
  const [agents, setAgents] = useState<Agent[]>(INITIAL_AGENTS);
  const [log, setLog] = useState<LogLine[]>([]);
  const [receipt, setReceipt] = useState<null | {
    amount: string;
    recipient: string;
    intent: string;
    tx: string;
  }>(null);
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  const logEndRef = useRef<HTMLDivElement>(null);
  const walletRef = useRef<WalletClient | null>(null);
  const coordinatorRef = useRef<MetaMaskSmartAccount | null>(null);

  // Budget meter scales to the real granted cap once we have it.
  const CAP = grantResult ? Number(grantResult.periodAmount) : 100_000; // micro-USDC
  const PRICE = 10_000; // 0.01 USDC (still mock until run-flow is wired)

  // Tick the expiry countdown while a grant is live.
  useEffect(() => {
    if (!grantResult || revoked) return;
    const id = setInterval(
      () => setNowSec(Math.floor(Date.now() / 1000)),
      1000
    );
    return () => clearInterval(id);
  }, [grantResult, revoked]);

  const remaining = grantResult
    ? Math.max(0, grantResult.expiry - nowSec)
    : null;
  const expiryText =
    remaining == null
      ? "—"
      : `${String(Math.floor(remaining / 60)).padStart(2, "0")}:${String(
          remaining % 60
        ).padStart(2, "0")}`;

  const append = useCallback((kind: LogKind, text: string) => {
    setLog((l) => [...l, { t: now(), kind, text }]);
    requestAnimationFrame(() =>
      logEndRef.current?.scrollIntoView({ behavior: "smooth" })
    );
  }, []);

  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const setAgent = (id: Agent["id"], state: AgentState) =>
    setAgents((a) => a.map((x) => (x.id === id ? { ...x, state } : x)));

  // --- actions -----------------------------------------------------------

  // REAL: viem walletClient over the injected provider; ensures Base Sepolia.
  const connect = async () => {
    if (busy) return;
    setBusy(true);
    append("info", "Connecting wallet…");
    try {
      const { address, walletClient } = await connectWallet();
      walletRef.current = walletClient;
      setAccount(address);
      setConnected(true);
      append("ok", `Wallet connected · ${shorten(address)} · Base Sepolia`);
    } catch (e) {
      append("reject", `Connect failed · ${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  };

  // REAL: ERC-7715 grant. Creates the coordinator session account, then opens
  // MetaMask's Advanced Permissions dialog (MetaMask does the EIP-7702 upgrade).
  const grant = async () => {
    if (busy || !walletRef.current) return;
    setBusy(true);
    try {
      append("info", "Creating coordinator session account…");
      const coordinator = await createCoordinatorAccount();
      coordinatorRef.current = coordinator;
      append("agent", `Coordinator account · ${shorten(coordinator.address)}`);

      append(
        "info",
        `Requesting ERC-7715 permission: ${amountInput} USDC / ${periodLabel(
          periodSeconds
        )}…`
      );
      const result = await grantBudget({
        walletClient: walletRef.current,
        chainId: config.chainId,
        coordinator,
        amountUsdc: amountInput,
        periodDuration: periodSeconds,
      });
      setGrantResult(result);
      setGranted(true);
      setAgent("coordinator", "active");
      append("ok", "Permission granted · Coordinator holds the root policy");
      append(
        "info",
        "EIP-7702 authorization handled by MetaMask · EOA → Smart Account"
      );
    } catch (e) {
      append("reject", `Grant failed · ${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const runFlow = async () => {
    if (busy || revoked) return;
    setBusy(true);
    setReceipt(null);

    append("agent", "Coordinator › redelegating narrow rights to task agents");
    await wait(500);
    setAgent("discover", "active");
    append("agent", "discover › GET /asset  →  402 Payment Required (0.01 USDC)");
    await wait(700);
    setAgent("discover", "done");

    setAgent("execute", "active");
    append("pay", "execute › authority check: within grant ✓");
    await wait(500);
    append("pay", "execute › paying via Conduit → 1Shot relayer (gas in USDC)…");
    await wait(1100);
    const tx = "0x38b9574c7fbc04e2…995a47b8f";
    append("ok", `settled ✓  ${tx}  ·  X402IntentSettled emitted`);
    setSpent((s) => s + PRICE);
    setAgent("execute", "done");

    setAgent("claim", "active");
    append("agent", "claim › GET /asset  →  200 OK, asset unlocked");
    await wait(600);
    setAgent("claim", "done");

    setReceipt({
      amount: "0.01 USDC",
      recipient: "0xa5cA…7350",
      intent: "0xf3e8a26c…e75e748",
      tx,
    });
    setBusy(false);
  };

  const tryBreak = async (kind: "redirect" | "overspend" | "replay") => {
    if (busy || revoked) return;
    setBusy(true);
    const msgs: Record<typeof kind, string> = {
      redirect: "rogue execute › attempting transfer to its OWN address…",
      overspend: "rogue execute › attempting 5.00 USDC (over the bound amount)…",
      replay: "rogue execute › replaying the completed payment…",
    };
    const reverts: Record<typeof kind, string> = {
      redirect: "Rejected on-chain · X402Receipt: wrong-recipient",
      overspend: "Rejected on-chain · X402Receipt: amount-exceeds-cap",
      replay: "Rejected on-chain · IdEnforcer: id already used",
    };
    append("agent", msgs[kind]);
    await wait(900);
    append("reject", reverts[kind]);
    setBusy(false);
  };

  const killRoot = async () => {
    if (busy) return;
    setBusy(true);
    append("info", "User › disableDelegation(root) …");
    await wait(700);
    // cascade: every downstream agent goes dark
    for (const id of ["claim", "execute", "discover", "coordinator"] as const) {
      setAgent(id, "dark");
      await wait(180);
    }
    append("reject", "Root killed · every downstream agent's rights died at once");
    setRevoked(true);
    setBusy(false);
  };

  // Soft reset: clears the run (log / receipt / spent), keeps the wallet
  // connection and the live grant so you can run again with a fresh intent.
  const reset = () => {
    setLog([]);
    setReceipt(null);
    setSpent(0);
    setRevoked(false);
    setAgents(
      INITIAL_AGENTS.map((a) =>
        a.id === "coordinator" && granted ? { ...a, state: "active" } : a
      )
    );
  };

  const pct = Math.min(100, (spent / CAP) * 100);

  // What the card/meter show: the granted values once granted, else the
  // current dapp selection.
  const displayAmount = grantResult ? grantResult.periodAmountUsdc : amountInput;
  const displayPeriod = grantResult
    ? grantResult.periodLabel
    : periodLabel(periodSeconds);

  return (
    <main className="min-h-screen">
      {/* top bar */}
      <div className="border-b border-conduit-border/60">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link href="/" className="flex items-center gap-2.5">
            <Image src="/images/conduit-logo.png" alt="Conduit" width={28} height={28} className="h-7 w-7" />
            <span className="font-semibold tracking-tight">Conduit</span>
            <span className="mono ml-2 rounded-md border border-conduit-border px-2 py-0.5 text-[11px] text-conduit-muted">
              demo
            </span>
          </Link>
          {connected && account ? (
            <span className="mono rounded-lg border border-conduit-border px-3 py-1.5 text-xs text-conduit-cyan">
              {shorten(account)} · Base Sepolia
            </span>
          ) : (
            <button
              onClick={connect}
              disabled={busy}
              className="btn-primary text-sm disabled:opacity-40"
            >
              {busy ? "Connecting…" : "Connect wallet"}
            </button>
          )}
        </div>
      </div>

      <div className="mx-auto grid max-w-6xl gap-6 px-6 py-8 lg:grid-cols-12">
        {/* LEFT: permission + roster */}
        <div className="space-y-6 lg:col-span-4">
          {/* Permission card */}
          <section className="panel p-6">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-conduit-muted">
                Permission
              </h2>
              <span
                className={`mono rounded-md px-2 py-0.5 text-[11px] ${
                  revoked
                    ? "bg-conduit-magenta/15 text-conduit-magenta"
                    : granted
                      ? "bg-conduit-cyan/15 text-conduit-cyan"
                      : "border border-conduit-border text-conduit-muted"
                }`}
              >
                {revoked ? "revoked" : granted ? "active" : "not granted"}
              </span>
            </div>

            {!granted ? (
              <div className="mt-4 space-y-3">
                <p className="text-[15px] leading-relaxed text-conduit-muted">
                  Authorize an agent budget — single-use per request, revocable,
                  expires after one period.
                </p>
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-white">up to</span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    inputMode="decimal"
                    value={amountInput}
                    onChange={(e) => setAmountInput(e.target.value)}
                    disabled={!connected || busy}
                    className="mono w-24 rounded-lg border border-conduit-border bg-transparent px-2.5 py-1.5 text-white outline-none focus:border-conduit-cyan disabled:opacity-40"
                  />
                  <span className="text-white">USDC /</span>
                  <select
                    value={periodSeconds}
                    onChange={(e) => setPeriodSeconds(Number(e.target.value))}
                    disabled={!connected || busy}
                    className="mono rounded-lg border border-conduit-border bg-conduit-panel px-2.5 py-1.5 text-white outline-none focus:border-conduit-cyan disabled:opacity-40"
                  >
                    {PERIOD_OPTIONS.map((o) => (
                      <option
                        key={o.seconds}
                        value={o.seconds}
                        className="bg-conduit-panel"
                      >
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            ) : (
              <p className="mt-4 text-[15px] leading-relaxed">
                Authorizing{" "}
                <span className="font-semibold text-white">
                  up to {displayAmount} USDC / {displayPeriod}
                </span>
                , single-use per request, expires in{" "}
                <span className="mono text-conduit-cyan">{expiryText}</span>.
              </p>
            )}

            {/* budget meter */}
            <div className="mt-5">
              <div className="flex justify-between text-xs text-conduit-muted">
                <span>spent this {displayPeriod}</span>
                <span className="mono">
                  {(spent / 1e6).toFixed(2)} / {displayAmount} USDC
                </span>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/5">
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{
                    width: `${pct}%`,
                    background: "linear-gradient(90deg,#00E5FF,#7C3AED,#EC4899)",
                  }}
                />
              </div>
            </div>

            {!granted ? (
              <button
                onClick={grant}
                disabled={!connected || busy}
                className="btn-primary mt-6 w-full justify-center text-sm disabled:opacity-40"
              >
                Grant permission
              </button>
            ) : (
              <button
                onClick={killRoot}
                disabled={busy || revoked}
                className="mt-6 w-full justify-center rounded-xl border border-conduit-magenta/50 px-4 py-2.5 text-sm font-semibold text-conduit-magenta transition-colors hover:bg-conduit-magenta/10 disabled:opacity-40"
              >
                Kill root delegation
              </button>
            )}
          </section>

          {/* Agent roster */}
          <section className="panel p-6">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-conduit-muted">
              Agents
            </h2>
            <div className="mt-4 space-y-2.5">
              {agents.map((a) => (
                <div
                  key={a.id}
                  className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 transition-all duration-300 ${
                    a.state === "dark"
                      ? "border-conduit-border/40 opacity-30"
                      : "border-conduit-border"
                  }`}
                >
                  <span
                    className="h-2.5 w-2.5 rounded-full transition-all"
                    style={{
                      background: a.state === "dark" ? "#333" : a.accent,
                      boxShadow:
                        a.state === "active"
                          ? `0 0 12px ${a.accent}`
                          : "none",
                    }}
                  />
                  <div className="flex-1">
                    <div className="text-sm font-medium">
                      {a.id === "coordinator" ? a.label : `${a.label} agent`}
                    </div>
                    <div className="mono text-[11px] text-conduit-muted">
                      {a.scope}
                    </div>
                  </div>
                  <span className="mono text-[10px] uppercase text-conduit-muted">
                    {a.state}
                  </span>
                </div>
              ))}
            </div>
          </section>
        </div>

        {/* RIGHT: activity log + controls + receipt */}
        <div className="space-y-6 lg:col-span-8">
          {/* controls */}
          <section className="panel flex flex-wrap items-center gap-3 p-5">
            <button
              onClick={runFlow}
              disabled={!granted || busy || revoked}
              className="btn-primary text-sm disabled:opacity-40"
            >
              {busy ? "Running…" : "Run the flow"}
            </button>
            <span className="text-conduit-border">·</span>
            <span className="text-xs uppercase tracking-wide text-conduit-muted">
              try to break it
            </span>
            <button onClick={() => tryBreak("redirect")} disabled={!granted || busy || revoked} className="btn-ghost text-xs disabled:opacity-40">
              Redirect funds
            </button>
            <button onClick={() => tryBreak("overspend")} disabled={!granted || busy || revoked} className="btn-ghost text-xs disabled:opacity-40">
              Overspend
            </button>
            <button onClick={() => tryBreak("replay")} disabled={!granted || busy || revoked} className="btn-ghost text-xs disabled:opacity-40">
              Replay
            </button>
            <button onClick={reset} className="ml-auto text-xs text-conduit-muted underline-offset-4 hover:underline">
              reset
            </button>
          </section>

          {/* activity log */}
          <section className="panel p-0">
            <div className="border-b border-conduit-border/60 px-5 py-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-conduit-muted">
                Agent activity
              </h2>
            </div>
            <div className="h-[320px] overflow-y-auto px-5 py-4">
              {log.length === 0 ? (
                <p className="mono text-sm text-conduit-muted">
                  {connected
                    ? granted
                      ? "Ready. Hit “Run the flow”."
                      : "Grant the permission to begin."
                    : "Connect a wallet to begin."}
                </p>
              ) : (
                <div className="space-y-1.5">
                  {log.map((l, i) => (
                    <div key={i} className="mono flex gap-3 text-[13px] leading-relaxed">
                      <span className="shrink-0 text-conduit-muted/60">{l.t}</span>
                      <span className={logColor(l.kind)}>{l.text}</span>
                    </div>
                  ))}
                  <div ref={logEndRef} />
                </div>
              )}
            </div>
          </section>

          {/* receipt */}
          {receipt && (
            <section className="panel reveal p-6">
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-conduit-cyan shadow-glow" />
                <h2 className="text-sm font-semibold uppercase tracking-wide text-conduit-cyan">
                  Receipt · X402IntentSettled
                </h2>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-4 text-sm">
                <Field label="amount" value={receipt.amount} />
                <Field label="recipient" value={receipt.recipient} />
                <Field label="intent" value={receipt.intent} />
                <Field label="tx" value={receipt.tx} link />
              </div>
            </section>
          )}
        </div>
      </div>
    </main>
  );
}

function shorten(addr: string | null): string {
  if (!addr) return "—";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function errMsg(e: unknown): string {
  if (e && typeof e === "object" && "shortMessage" in e) {
    return String((e as { shortMessage: unknown }).shortMessage);
  }
  return e instanceof Error ? e.message : String(e);
}

function logColor(kind: LogKind): string {
  switch (kind) {
    case "ok": return "text-conduit-cyan";
    case "pay": return "text-white";
    case "agent": return "text-conduit-violet";
    case "reject": return "text-conduit-magenta font-semibold";
    default: return "text-conduit-muted";
  }
}

function Field({ label, value, link }: { label: string; value: string; link?: boolean }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-conduit-muted">{label}</div>
      <div className={`mono mt-1 break-all ${link ? "text-conduit-cyan underline-offset-4 hover:underline cursor-pointer" : ""}`}>
        {value}
      </div>
    </div>
  );
}

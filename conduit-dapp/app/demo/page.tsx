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
import { fetch402, payAndClaim } from "@/lib/endpoint";
import { buildPayment, type Eip7702Authorization } from "@/lib/payment";
import { config } from "@/lib/config";

/* ===========================================================================
   Conduit demo.
   WIRED (real): Connect (Privy: email / GitHub / external wallet), Grant
   (manual root delegation via signTypedData + EIP-7702 auth via Privy's
   useSign7702Authorization), Run flow (intent-bound redelegation → facilitator
   /verify + /settle, with the 7702 auth bundled into the first redeem).
   Still MOCK: break-it buttons (next: real overrides), kill-root.
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
  // Privy (auth) + wagmi (wallet client). Privy drives the connect modal and
  // 7702 signing; wagmi gives us a standard viem walletClient for delegations.
  const { ready, authenticated, logout } = usePrivy();
  const { login } = useLogin();
  const { signAuthorization } = useSign7702Authorization();
  const { wallets } = useWallets();
  const { setActiveWallet } = useSetActiveWallet();
  const { address, isConnected } = useAccount();
  // Bind to the configured chain explicitly — useWalletClient() with no args
  // returns null when the active wallet hasn't been put on that chain yet.
  const { data: walletClient } = useWalletClient({ chainId: config.chainId });
  const connected = ready && authenticated && isConnected && !!address;

  // Privy can return multiple wallets (Ethereum embedded + Solana embedded +
  // any external the user connected). Force-bind the EMBEDDED Ethereum one
  // to wagmi so useAccount/useWalletClient resolve to a usable signer.
  useEffect(() => {
    if (!authenticated || wallets.length === 0) return;
    const embedded = getEmbeddedConnectedWallet(wallets);
    const ethExternal = wallets.find((w) => w.chainId?.startsWith("eip155:"));
    const target = embedded ?? ethExternal ?? wallets[0];
    if (!target) return;
    if (address && address.toLowerCase() === target.address.toLowerCase()) return;
    void setActiveWallet(target);
  }, [authenticated, wallets, address, setActiveWallet]);

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
  // The 7702 authorization, signed at grant time and bundled into the FIRST
  // redeem; cleared after a successful settle (subsequent runs don't need it).
  const [authorization, setAuthorization] = useState<Eip7702Authorization | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);
  const coordinatorRef = useRef<Coordinator | null>(null);

  // Budget meter scales to the real granted cap once we have it.
  const CAP = grantResult ? Number(grantResult.periodAmount) : 100_000; // micro-USDC

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

  // Open Privy's login modal (email / GitHub / external wallet).
  const connect = async () => {
    if (busy) return;
    append("info", "Opening sign-in…");
    try {
      login();
    } catch (e) {
      append("reject", `Sign-in failed · ${errMsg(e)}`);
    }
  };

  // Sign-out: clear coordinator + grant + auth so the next session starts clean.
  const disconnect = async () => {
    try {
      await logout();
    } finally {
      coordinatorRef.current = null;
      setGranted(false);
      setGrantResult(null);
      setAuthorization(null);
      setRevoked(false);
      setSpent(0);
      setAgents(INITIAL_AGENTS);
      setLog([]);
      setReceipt(null);
    }
  };

  // Grant: (1) create the coordinator session EOA, (2) sign the 7702 auth via
  // Privy (designating the user EOA to EIP7702StatelessDeleGator — required
  // for the 1Shot track), (3) build + sign the root delegation off-chain via
  // walletClient.signTypedData (no snap, no 403).
  const grant = async () => {
    if (busy) return;
    if (!walletClient || !address) {
      append(
        "info",
        `Waiting for wallet to bind… (walletClient=${!!walletClient}, address=${!!address}, wallets=${wallets.length})`
      );
      return;
    }
    setBusy(true);
    try {
      append("info", "Creating coordinator session account…");
      const coordinator = createCoordinatorAccount();
      coordinatorRef.current = coordinator;
      append("agent", `Coordinator account · ${shorten(coordinator.address)}`);

      // EIP-7702 designation is OPTIONAL on testnet: the DelegationManager
      // validates an EOA delegator via plain ECDSA, so the root delegation
      // signed below settles without upgrading the account. The 7702 upgrade is
      // the 1Shot *mainnet* track requirement and is done through 1Shot's
      // relayer in that phase — so we only sign it here when the user has a
      // Privy embedded wallet (whose first-class hook supports it). External
      // wallets (Zerion, etc.) skip it cleanly.
      const embeddedWallet = getEmbeddedConnectedWallet(wallets);
      if (embeddedWallet) {
        try {
          append(
            "info",
            `Signing EIP-7702 authorization · designating ${shorten(config.eip7702Impl)}…`
          );
          const auth = await signAuthorization(
            { contractAddress: config.eip7702Impl, chainId: config.chainId },
            { address: embeddedWallet.address }
          );
          setAuthorization({
            chainId: auth.chainId,
            address: auth.address as `0x${string}`,
            nonce: auth.nonce,
            r: auth.r,
            s: auth.s,
            yParity: (auth.yParity === 1 ? 1 : 0) as 0 | 1,
          });
          append("ok", "EIP-7702 authorization signed · bundled into the first redeem");
        } catch (e) {
          append("info", `7702 designation skipped (${errMsg(e)}) · delegation still validates via ECDSA`);
        }
      } else {
        append("info", "External wallet · 7702 designation deferred to the 1Shot mainnet phase");
      }

      append(
        "info",
        `Asking for permission: ${amountInput} USDC / ${periodLabel(periodSeconds)}…`
      );
      const result = await grantBudget({
        walletClient,
        userAddress: address,
        coordinator,
        amountUsdc: amountInput,
        periodDuration: periodSeconds,
      });
      setGrantResult(result);
      setGranted(true);
      setAgent("coordinator", "active");
      append("ok", "Permission granted · Coordinator holds the root policy");
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[conduit] grant failed →", e);
      append("reject", `Grant failed · ${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  };

  // REAL: discover (402) → execute (intent-bound redelegation → endpoint →
  // facilitator /verify + /settle) → claim. Surfaces the real on-chain receipt.
  const runFlow = async () => {
    if (busy || revoked || !grantResult || !coordinatorRef.current) return;
    setBusy(true);
    setReceipt(null);
    try {
      append("agent", "Coordinator › preparing intent-bound redelegation");

      // --- discover: read the 402 requirements (no spend) ----------------
      setAgent("discover", "active");
      append("agent", "discover › GET /paid-data");
      const req = await fetch402();
      const price = formatUnits(BigInt(req.maxAmountRequired), 6);
      append(
        "agent",
        `discover › 402 Payment Required · ${price} USDC → ${shorten(req.payTo)}`
      );
      setAgent("discover", "done");

      // --- execute: build + sign the bound redelegation, then pay --------
      setAgent("execute", "active");
      append("pay", "execute › binding payment · X402ReceiptEnforcer + IdEnforcer");
      if (authorization) {
        append("pay", "execute › bundling EIP-7702 auth (first run · designates the EOA)");
      }
      const built = await buildPayment({
        grant: grantResult,
        coordinator: coordinatorRef.current,
        req,
        // First run bundles the 7702 auth into the redeem; after settle we
        // clear it (the account is now designated, subsequent runs skip it).
        authorization: authorization ?? undefined,
      });
      append(
        "pay",
        `execute › intent ${shorten(built.intentHash)} · redeemer ${shorten(req.redeemer!)}`
      );
      append("pay", "execute › X-PAYMENT → facilitator /verify → /settle…");
      const claim = await payAndClaim(built.paymentPayload);
      if (!claim.ok) {
        setAgent("execute", "idle");
        append("reject", `Rejected on-chain · ${claim.error}`);
        return;
      }
      const tx = claim.settlement?.transaction ?? null;
      append(
        "ok",
        `settled ✓ ${tx ? shorten(tx) : "(pending)"} · ${
          claim.settlement?.status ?? "submitted"
        } · X402IntentSettled`
      );
      // Designation succeeded along with the payment — clear the auth so we
      // don't re-bundle on subsequent runs (would conflict on nonce).
      if (authorization) setAuthorization(null);
      setSpent((s) => s + Number(built.amount));
      setAgent("execute", "done");

      // --- claim: the asset is now unlocked ------------------------------
      setAgent("claim", "active");
      append("agent", "claim › GET /paid-data → 200 OK, asset unlocked");
      setAgent("claim", "done");

      setReceipt({
        amount: `${formatUnits(built.amount, 6)} USDC`,
        recipient: built.payTo,
        intent: built.intentHash,
        tx: tx ?? "(pending)",
      });
    } catch (e) {
      append("reject", `Run failed · ${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
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
          {connected && address ? (
            <div className="flex items-center gap-2">
              <span className="mono rounded-lg border border-conduit-border px-3 py-1.5 text-xs text-conduit-cyan">
                {shorten(address)} · Base Sepolia
              </span>
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
                    : "Sign in to begin."}
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
  if (e && typeof e === "object") {
    const o = e as Record<string, unknown>;
    // MetaMask snap RPC errors expose richer detail in nested fields; pick the
    // most informative one we can reach.
    const data = o.data as Record<string, unknown> | undefined;
    const cause = o.cause as Record<string, unknown> | undefined;
    const candidates = [
      o.shortMessage,
      data?.message,
      cause?.shortMessage,
      cause?.message,
      o.message,
    ];
    for (const c of candidates) if (typeof c === "string" && c) return c;
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

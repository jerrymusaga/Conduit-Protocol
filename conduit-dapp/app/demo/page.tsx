"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAccount, useWalletClient, useSwitchChain } from "wagmi";
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
  createCoordinatorAccount,
  grantBudget,
  revokeRootDelegation,
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
import type { Eip7702Authorization } from "@/lib/payment";
import { useFacilitatorEvents } from "@/lib/useFacilitatorEvents";
import { config } from "@/lib/config";
import { publicClient } from "@/lib/chain";
import { readBudgetState, type BudgetState } from "@/lib/onchain";
import { CoordinationCanvas } from "@/components/CoordinationCanvas";

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
  /** Specialist sub-agent address (A2A mode) — the redelegate the coordinator hired. */
  agentAddress?: string;
  /** True when this payment runs as a 3-hop A2A (coordinator → specialist → relayer). */
  a2a?: boolean;
}

/** How long the whole grant stays valid (TimestampEnforcer). Independent of
 *  the spend window above — e.g. "≤$5/hour, valid for a week". */
const EXPIRY_OPTIONS = [
  { label: "5 minutes", seconds: 300 },
  { label: "1 hour", seconds: 3600 },
  { label: "1 day", seconds: 86400 },
  { label: "1 week", seconds: 604800 },
] as const;

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
  const { address, isConnected, chainId: activeChainId } = useAccount();
  const { switchChain } = useSwitchChain();
  const { data: walletClient } = useWalletClient({ chainId: config.chainId });
  const connected = ready && authenticated && isConnected && !!address;
  // External wallets (MetaMask) connect on whatever network the user has
  // selected; the embedded wallet is always on the app chain. If the active
  // wallet is on the wrong chain, useWalletClient({chainId}) is null → "waiting
  // to bind". Detect + prompt a switch to Base Sepolia.
  const wrongChain = connected && !!activeChainId && activeChainId !== config.chainId;

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

  // Keep the active wallet on Base Sepolia (external wallets may be elsewhere).
  useEffect(() => {
    if (wrongChain) {
      try {
        switchChain?.({ chainId: config.chainId });
      } catch {
        /* user can switch manually; the grant guard surfaces the hint */
      }
    }
  }, [wrongChain, switchChain]);

  // Grant / permission state.
  const [granted, setGranted] = useState(false);
  const [revoked, setRevoked] = useState(false);
  // Whether the connected account already has on-chain code (a smart account —
  // MetaMask Smart Account or a 7702-upgraded EOA). null = unknown/checking.
  const [hasCode, setHasCode] = useState<boolean | null>(null);
  const [grantResult, setGrantResult] = useState<GrantResult | null>(null);
  const [amountInput, setAmountInput] = useState<string>(BUDGET.periodAmountUsdc);
  // Absolute expiry (datetime-local string); default = now + 1 hour.
  const [expiryAt, setExpiryAt] = useState<string>(() => toLocalDatetime(Date.now() + 86_400_000));
  const [authorization, setAuthorization] = useState<Eip7702Authorization | null>(null);
  const coordinatorRef = useRef<Coordinator | null>(null);

  // Console state.
  const [prompt, setPrompt] = useState("Generate a complete ETH staking market report.");
  const [mode, setMode] = useState<A2AMode>("a2a");
  const [busy, setBusy] = useState(false);
  const [spent, setSpent] = useState(0); // micro-USDC settled (optimistic, during a run)
  const [budgetState, setBudgetState] = useState<BudgetState | null>(null); // on-chain truth
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

  // Before a grant exists, preview the meter against the typed amount (not a
  // hardcoded fallback), so "remaining" matches what the user is about to grant.
  const CAP = grantResult
    ? Number(grantResult.periodAmount)
    : Math.max(0, Math.round((Number(amountInput) || 0) * 1e6));
  // Meter prefers the on-chain truth when idle (cumulative, period-aware);
  // during a run it follows the optimistic counter for smooth animation.
  const effectiveSpent = !busy && budgetState ? Number(budgetState.spent) : spent;
  const spentClamped = Math.min(effectiveSpent, CAP);
  const pct = Math.min(100, (effectiveSpent / CAP) * 100);
  const remainingAtoms = !busy && budgetState ? Number(budgetState.available) : Math.max(0, CAP - spent);
  const remainingUsdc = (Math.max(0, Math.min(remainingAtoms, CAP)) / 1e6).toFixed(2);
  const secsLeft = grantResult ? Math.max(0, grantResult.expiry - nowSec) : null;
  const expiryText = secsLeft == null ? "—" : fmtCountdown(secsLeft);
  const displayAmount = grantResult ? grantResult.periodAmountUsdc : amountInput;

  // Account-type gate: an external EOA that isn't a smart account can't complete
  // the flow (can't be 7702-upgraded from the dapp). Embedded EOAs are fine (we
  // sign the auth); accounts that already have code are fine (no auth needed).
  const isEmbeddedWallet = !!getEmbeddedConnectedWallet(wallets);
  const needsSmartAccount = connected && hasCode === false && !isEmbeddedWallet;

  // Run guard: distinguish a PERMANENT end (expired/revoked → new grant needed)
  // from a TEMPORARY period cap (budget refills next period → just wait).
  const expired = grantResult ? nowSec >= grantResult.expiry : false;
  const exhausted = !busy && !!budgetState && budgetState.exhausted;
  const runBlock: string | null = !granted
    ? null
    : expired
      ? "Permission expired — grant a new one"
      : exhausted
        ? "Budget spent — grant a new permission"
        : null;

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

  // Detect whether the connected account is already a smart account (has code).
  // Drives the 7702 branch: has code → no auth needed; embedded EOA → we sign
  // the auth; external EOA without code → guide them to enable a Smart Account.
  useEffect(() => {
    if (!connected || !address) {
      setHasCode(null);
      return;
    }
    let cancelled = false;
    publicClient
      .getCode({ address })
      .then((code) => {
        if (!cancelled) setHasCode(!!code && code !== "0x");
      })
      .catch(() => {
        if (!cancelled) setHasCode(null);
      });
    return () => {
      cancelled = true;
    };
  }, [connected, address, granted]);

  // Read the TRUE on-chain budget (cumulative, period-aware) so the meter +
  // "exhausted this period" guard are exact. Refresh on grant + periodically;
  // run() also refreshes right after a campaign settles.
  const refreshBudget = useCallback(async () => {
    if (!grantResult) {
      setBudgetState(null);
      return;
    }
    try {
      setBudgetState(await readBudgetState(grantResult));
    } catch {
      /* transient RPC error — keep the last known state */
    }
  }, [grantResult]);

  useEffect(() => {
    if (!granted || !grantResult) {
      setBudgetState(null);
      return;
    }
    void refreshBudget();
    const id = setInterval(() => void refreshBudget(), 8000);
    return () => clearInterval(id);
  }, [granted, grantResult, refreshBudget]);

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
      setRevoked(false);
      setGrantResult(null);
      setAuthorization(null);
      setSpent(0);
      setCards([]);
      setLog([]);
      rehydrated.current = false;
      clearSession();
    }
  };

  // Cascading revoke (kill-root): disableDelegation on the budget root → every
  // task agent under it dies at once. A direct on-chain tx from the user's own
  // account (only the delegator can revoke) → needs a little ETH for gas.
  const revoke = async () => {
    if (busy || !granted || !grantResult || !walletClient || !address) return;
    setBusy(true);
    append("Revoking the budget on-chain · disableDelegation cascades to every task agent (needs a little ETH)…");
    try {
      const tx = await revokeRootDelegation({
        walletClient,
        userAddress: address,
        context: grantResult.context,
        delegationManager: grantResult.delegationManager,
      });
      append(`Revoke tx · ${shorten(tx)} — awaiting confirmation…`);
      await publicClient.waitForTransactionReceipt({ hash: tx });
      append("Budget revoked ✓ · every task agent under this grant is now dead on-chain");
      setRevoked(true); // keep the tree on screen, dimmed — the cascading-death beat
      coordinatorRef.current = null;
      setGranted(false);
      setGrantResult(null);
      setAuthorization(null);
      clearSession();
    } catch (e) {
      append(`Revoke failed · ${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  };

  // Grant: coordinator EOA + 7702 auth (embedded wallet) + root delegation.
  const grant = async () => {
    if (busy) return;
    if (wrongChain) {
      append("Wrong network — switch your wallet to Base Sepolia (approve the switch in MetaMask), then Grant.");
      try {
        await switchChain?.({ chainId: config.chainId });
      } catch {
        /* user declined; they can switch manually */
      }
      return;
    }
    if (!walletClient || !address) {
      append("Waiting for wallet to bind… if it persists, switch your wallet to Base Sepolia and reconnect.");
      return;
    }
    const embeddedWallet = getEmbeddedConnectedWallet(wallets);
    // An external EOA that isn't a smart account can't be 7702-upgraded from the
    // dapp (and we can't bundle an auth for it) — so the redeem would fail.
    // Guide the user instead of letting settle revert cryptically.
    if (hasCode === false && !embeddedWallet) {
      append("This MetaMask account isn't a Smart Account yet — enable MetaMask Smart Account in your wallet (Settings → enable smart account), or sign in with email, then Grant.");
      return;
    }
    setBusy(true);
    try {
      append("Creating coordinator session account…");
      const coordinator = createCoordinatorAccount();
      coordinatorRef.current = coordinator;
      append(`Coordinator account · ${shorten(coordinator.address)}`);

      let signedAuth: Eip7702Authorization | null = null;
      if (hasCode) {
        // Already a smart account (MetaMask Smart Account or a previously-7702'd
        // embedded wallet) → it has code on-chain, so redeemDelegations executes
        // directly. No dapp-side 7702 authorization needed.
        append("Smart Account detected ✓");
      } else if (embeddedWallet) {
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
      }

      const expirySeconds = Math.max(
        60,
        Math.floor(new Date(expiryAt).getTime() / 1000) - Math.floor(Date.now() / 1000)
      );
      append(`Requesting permission: up to ${amountInput} USDC, expires in ${fmtCountdown(expirySeconds)}…`);
      const result = await grantBudget({
        walletClient,
        userAddress: address,
        coordinator,
        amountUsdc: amountInput,
        // One budget for the grant's life: the spend window == the expiry, so
        // there's no mid-grant reset (no confusing "per hour/day/week").
        periodDuration: expirySeconds,
        expirySeconds,
      });
      setGrantResult(result);
      setAuthorization(signedAuth);
      setGranted(true);
      setRevoked(false);
      setCards([]);
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
    setRevoked(false);
    setSpent(0); // each campaign meters its own spend against the period cap
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
          onTask: (task, agentAddress) =>
            setCardStage(task.taskId, { agentAddress, a2a: true }),
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
      void refreshBudget(); // reconcile the meter to on-chain truth post-run
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
            <Link
              href="/subscription"
              className="text-xs text-conduit-muted underline-offset-4 hover:text-white hover:underline"
            >
              subscriptions →
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
        {/* LEFT: permission (the prerequisite) above the prompt + budget */}
        <div className="flex flex-col gap-6 lg:col-span-3">
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
              disabled={!granted || busy || !!runBlock}
              className="btn-primary mt-4 w-full justify-center text-sm disabled:opacity-40"
            >
              {busy ? "Running…" : "Run"}
            </button>
            {runBlock && (
              <p className="mt-2 text-center text-[11px] leading-relaxed text-conduit-magenta">
                {runBlock}
                {expired && (
                  <span className="mt-1 block text-conduit-muted">
                    Grant a new permission to continue.
                  </span>
                )}
              </p>
            )}

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

          {/* Permission — the prerequisite, ordered first in the column */}
          <section className="panel order-first p-6">
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
                  Authorize an agent budget — erc7715, bound per request, revocable anytime.
                </p>
                <label className="flex items-center gap-2 text-sm">
                  <span className="text-white">budget — up to</span>
                  <input
                    type="number" min="0" step="0.01" inputMode="decimal"
                    value={amountInput}
                    onChange={(e) => setAmountInput(e.target.value)}
                    disabled={!connected || busy}
                    className="mono w-24 rounded-lg border border-conduit-border bg-transparent px-2 py-1.5 text-white outline-none focus:border-conduit-cyan disabled:opacity-40"
                  />
                  <span className="text-white">USDC</span>
                </label>
                <div className="space-y-1.5 text-sm">
                  <span className="text-white">expires</span>
                  <input
                    type="datetime-local"
                    value={expiryAt}
                    min={toLocalDatetime(Date.now() + 60_000)}
                    onChange={(e) => setExpiryAt(e.target.value)}
                    disabled={!connected || busy}
                    className="mono w-full rounded-lg border border-conduit-border bg-conduit-panel px-2 py-1.5 text-white outline-none focus:border-conduit-cyan disabled:opacity-40"
                  />
                  <div className="flex flex-wrap gap-1.5">
                    {EXPIRY_OPTIONS.map((o) => (
                      <button
                        key={o.seconds}
                        type="button"
                        onClick={() => setExpiryAt(toLocalDatetime(Date.now() + o.seconds * 1000))}
                        disabled={!connected || busy}
                        className="mono rounded-md border border-conduit-border px-2 py-0.5 text-[11px] text-conduit-muted transition-colors hover:border-conduit-cyan/50 hover:text-conduit-cyan disabled:opacity-40"
                      >
                        +{o.label}
                      </button>
                    ))}
                  </div>
                </div>
                <button
                  onClick={grant}
                  disabled={!connected || busy || needsSmartAccount}
                  className="btn-primary mt-1 w-full justify-center text-sm disabled:opacity-40"
                >
                  Grant permission
                </button>
                {connected && (
                  <p className="text-[11px] leading-relaxed text-conduit-muted">
                    {needsSmartAccount ? (
                      <span className="text-conduit-magenta">
                        This MetaMask account isn&apos;t a Smart Account yet. Enable
                        MetaMask Smart Account in your wallet, or sign in with email.
                      </span>
                    ) : hasCode ? (
                      <span className="text-conduit-cyan">MetaMask Smart Account detected ✓</span>
                    ) : isEmbeddedWallet ? (
                      <span className="text-conduit-muted">Embedded wallet — you&apos;ll sign a one-time 7702 upgrade with the grant.</span>
                    ) : null}
                  </p>
                )}
              </div>
            ) : (
              <p className="mt-4 text-[13px] leading-relaxed text-conduit-muted">
                Authorizing{" "}
                <span className="font-semibold text-white">up to {displayAmount} USDC</span> for
                this task. Expires in <span className="mono text-conduit-cyan">{expiryText}</span>.
              </p>
            )}

            {/* budget meter */}
            <div className="mt-5">
              <div className="flex justify-between text-xs text-conduit-muted">
                <span>spent</span>
                <span className="mono">
                  {(spentClamped / 1e6).toFixed(2)} / {displayAmount} USDC
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
                <span className="mono text-white">{remainingUsdc} USDC</span>
              </div>
            </div>

            {/* Cascading revoke — the kill switch. Disables the root → all task
                agents under it die at once (the "cascading revoke" beat). */}
            {granted && (
              <div className="mt-5 border-t border-conduit-border/60 pt-4">
                <button
                  onClick={revoke}
                  disabled={busy}
                  className="w-full rounded-lg border border-conduit-magenta/40 px-3 py-2 text-xs font-medium text-conduit-magenta transition-colors hover:bg-conduit-magenta/10 disabled:opacity-40"
                >
                  {busy ? "Working…" : "Revoke budget — kill all agents (on-chain)"}
                </button>
                <p className="mt-1.5 text-[11px] leading-relaxed text-conduit-muted/70">
                  Disables the root delegation; every task agent under it dies at once. Your
                  own kill switch — direct on-chain tx (needs a little ETH).
                </p>
              </div>
            )}
          </section>
        </div>

        {/* CENTER: the live event feed — the star */}
        <div className="lg:col-span-6">
          <section className="panel p-0">
            <div className="flex items-center justify-between border-b border-conduit-border/60 px-5 py-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-conduit-muted">
                Agent coordination
              </h2>
              <span className="mono text-[11px] text-conduit-muted">
                one permission · many agents · every payment gated by Conduit
              </span>
            </div>
            <div className="px-5 py-5">
              <CoordinationCanvas
                userAddress={address}
                coordinatorAddress={coordinatorRef.current?.address}
                cards={cards}
                mode={mode}
                budget={{
                  capUsdc: displayAmount,
                  spentUsdc: (spentClamped / 1e6).toFixed(2),
                  remainingUsdc,
                  pct,
                  expiryText,
                }}
                revoked={revoked}
              />
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

// --- helpers ---------------------------------------------------------------

function shorten(addr: string | null): string {
  if (!addr) return "—";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/** Format a timestamp (ms) as a local "YYYY-MM-DDTHH:mm" for a datetime-local input. */
function toLocalDatetime(ms: number): string {
  const off = new Date(ms).getTimezoneOffset() * 60_000;
  return new Date(ms - off).toISOString().slice(0, 16);
}

/** Adaptive countdown: days/hours for long grants, mm:ss only under an hour. */
function fmtCountdown(sec: number): string {
  if (sec <= 0) return "expired";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
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

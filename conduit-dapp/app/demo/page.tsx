"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
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
  runCommissionAtomic,
  attemptRogue,
  type A2AMode,
  type PlanItem,
  type PlannedItem,
  type ServiceResult,
  type RogueKind,
  type RogueAttack,
} from "@/lib/coordinator";
import type { Eip7702Authorization } from "@/lib/payment";
import { keccak256, parseUnits, formatUnits, type Hex } from "viem";
import { Erc7710Inspector, type InspectorBinding } from "@/components/Erc7710Inspector";
import { useFacilitatorEvents } from "@/lib/useFacilitatorEvents";
import { fetchJob, fetch402 } from "@/lib/endpoint";
import { registerGrant } from "@/lib/grants";
import {
  grantSwap,
  buildSwapCommission,
  settleSwap,
  resolveSwapBounds,
  isTradeIntent,
  parseTradeIntent,
  type SwapGrant,
} from "@/lib/trade";
import { config } from "@/lib/config";
import { publicClient } from "@/lib/chain";
import { readBudgetState, readUsdcBalance, type BudgetState } from "@/lib/onchain";
import { CoordinationCanvas } from "@/components/CoordinationCanvas";
import { type DiscoveredAgent } from "@/lib/discovery";

/* ===========================================================================
   Conduit — facilitator operations console.
   Conduit is the star: a live feed of x402 payments flowing through the
   facilitator (request → permission → settle → released), each authorized
   against ONE erc7715 permission, multiple agents draining one budget.
   Client coordinator narrates each card instantly; the facilitator's SSE
   stream annotates/confirms them (smoothest UX).
   =========================================================================== */

type CardStage = "queued" | "requested" | "allowed" | "denied" | "settling" | "settled" | "failed";

/** A throwaway address for the rogue-swap beat (redirect target). */
function randomRogueAddr(): Hex {
  const b = crypto.getRandomValues(new Uint8Array(20));
  return (`0x${Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("")}`) as Hex;
}

type TradeStage = "approving" | "settling" | "settled" | "failed" | "blocked";

interface TradeResult {
  stage: TradeStage;
  /** USDC spent (base units) + the bounds the swap was authorised under. */
  amountIn: bigint;
  minAmountOut: bigint;
  tokenOutSymbol: string;
  slippageBps: number;
  txHash?: string | null;
  confirmedVia?: "webhook" | "poll" | null;
  reason?: string | null;
  /** A deliberate rogue swap (redirect proceeds) — expected to be blocked. */
  rogue?: boolean;
}

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
  /** Where the purchased output came from (e.g. "venice:crypto-rpc · …"). */
  source?: string;
  /** Rogue attempt kind (drives the attack inspector template). */
  rogueKind?: RogueKind;
  /** The x402 attack vector detail (field-level) for the intruder lane. */
  attack?: RogueAttack;
  /** Rejected because it would exceed the granted budget (not a rogue/attack). */
  budgetCapped?: boolean;
}

/** One purchased provider's contribution to the aggregated report. */
interface ReportSection {
  agent: string;
  label: string;
  priceUsdc: string;
  output: { type?: string; content?: unknown; source?: string; transcript?: string };
  /** Ties the section back to its payment card for live settlement state. */
  correlationId: string;
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
  const [showGrantForm, setShowGrantForm] = useState(false); // re-open the form to grant a NEW permission while one is active
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
  const [prompt, setPrompt] = useState("Create a launch brief for a new AI productivity app — research the space, write the positioning, design a cover image, and record a voiceover.");
  // A2A coordination mode. Default = real agent-to-agent: one specialist
  // sub-agent (own on-chain key) per purchased service. `looped` (coordinator
  // pays directly, fewer hops) is a silent live-reliability fallback reachable
  // via ?mode=looped — not exposed in the UI.
  const [mode, setMode] = useState<A2AMode>("a2a");
  useEffect(() => {
    const m = new URLSearchParams(window.location.search).get("mode");
    if (m === "looped" || m === "a2a") setMode(m);
  }, []);
  const [busy, setBusy] = useState(false);
  const [spent, setSpent] = useState(0); // micro-USDC settled (optimistic, during a run)
  const [budgetState, setBudgetState] = useState<BudgetState | null>(null); // on-chain truth
  const [usdcBalance, setUsdcBalance] = useState<bigint | null>(null); // user's live USDC
  const [cards, setCards] = useState<FeedCard[]>([]);
  const [market, setMarket] = useState<DiscoveredAgent[]>([]); // discovered on ERC-8004
  const [budgetForecast, setBudgetForecast] = useState<{ planTotal: bigint; budget: bigint } | null>(null);
  // Plan cost > budget: the run paused before spending. Drives the pause panel.
  // `atomic` records which path paused so the continuation resumes the same one.
  const [budgetPause, setBudgetPause] = useState<{ planTotal: bigint; budget: bigint; atomic?: boolean } | null>(null);
  // Set when an atomic commission settles: the SINGLE tx that paid the whole team.
  const [atomicResult, setAtomicResult] = useState<
    { tx: string | null; jobId?: string; count: number; total: bigint; confirmedVia?: "webhook" | "poll" | null } | null
  >(null);
  const [report, setReport] = useState<ReportSection[] | null>(null); // aggregated final report
  const reportRef = useRef<ReportSection[]>([]); // accumulates outputs during a run
  const [reportMarkdown, setReportMarkdown] = useState<string | null>(null); // Venice-aggregated prose
  const [reportTitle, setReportTitle] = useState<string | null>(null); // deliverable title (derived from prompt, upgraded by Venice H1)
  // Trading (isolated, trade-intent prompts only): the SwapBounds grant + the
  // executed-trade result. Never touches the research/payment path above.
  const swapGrantRef = useRef<SwapGrant | null>(null);
  const [swapAuthorized, setSwapAuthorized] = useState(false); // a swap grant was signed (trade intent)
  const [tradeResult, setTradeResult] = useState<TradeResult | null>(null);
  // Voice input: record the spoken prompt, transcribe via Venice STT.
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
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

  // The user's live USDC balance — shown from the moment a wallet connects
  // (independent of any grant) and refreshed after each run.
  const refreshBalance = useCallback(async () => {
    if (!address) {
      setUsdcBalance(null);
      return;
    }
    try {
      setUsdcBalance(await readUsdcBalance(address as `0x${string}`));
    } catch {
      /* transient RPC error — keep the last known balance */
    }
  }, [address]);

  useEffect(() => {
    if (!connected || !address) {
      setUsdcBalance(null);
      return;
    }
    void refreshBalance();
    const id = setInterval(() => void refreshBalance(), 12000);
    return () => clearInterval(id);
  }, [connected, address, refreshBalance]);

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
          if (ev.stage === "settle") {
            // Never regress an already-confirmed card on a late/replayed submit
            // event; and don't clobber a known tx with a null.
            return c.stage === "settled"
              ? c
              : { ...c, stage: "settling", txHash: ev.txHash ?? c.txHash };
          }
          if (ev.stage === "settled") {
            return ev.status === "confirmed"
              ? { ...c, stage: "settled", txHash: ev.txHash ?? c.txHash }
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
      setReport(null);
      setReportTitle(null);
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
  const grant = async (): Promise<GrantResult | null> => {
    if (busy) return null;
    if (wrongChain) {
      append("Wrong network — switch your wallet to Base Sepolia (approve the switch in MetaMask), then Grant.");
      try {
        await switchChain?.({ chainId: config.chainId });
      } catch {
        /* user declined; they can switch manually */
      }
      return null;
    }
    if (!walletClient || !address) {
      append("Waiting for wallet to bind… if it persists, switch your wallet to Base Sepolia and reconnect.");
      return null;
    }
    const embeddedWallet = getEmbeddedConnectedWallet(wallets);
    // An external EOA that isn't a smart account can't be 7702-upgraded from the
    // dapp (and we can't bundle an auth for it) — so the redeem would fail.
    // Guide the user instead of letting settle revert cryptically.
    if (hasCode === false && !embeddedWallet) {
      append("This MetaMask account isn't a Smart Account yet — enable MetaMask Smart Account in your wallet (Settings → enable smart account), or sign in with email, then Grant.");
      return null;
    }
    setBusy(true);
    let grantedResult: GrantResult | null = null;
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
      setShowGrantForm(false); // collapse the re-grant form back to the active view
      setRevoked(false);
      setCards([]);
      grantedResult = result;
      // The session-sync effect persists grant+coordinator+auth+spent so a
      // refresh restores the active session (survives reload).
      append("Permission granted · the coordinator holds the root policy");
      // Register in the per-wallet grants index so /portfolio can enumerate it
      // (ERC-7715 grants have no on-chain "created" event). Best-effort.
      void registerGrant({
        id: keccak256(result.context),
        user: address,
        kind: "budget",
        label: deriveTitle(prompt) || "Agent budget",
        prompt,
        coordinator: coordinator.address,
        token: config.usdc,
        amount: result.periodAmount.toString(),
        expiry: result.expiry,
        periodSeconds: result.periodDuration,
        enforcer: config.erc20PeriodTransferEnforcer,
        context: result.context,
      });

      // TRADE intent → also sign a SwapBounds authorization (separate from the
      // spend budget, which only allows transfers). Isolated: only trade prompts.
      swapGrantRef.current = null;
      setSwapAuthorized(false);
      if (isTradeIntent(prompt) && walletClient && address) {
        try {
          const { amountInUsdc, slippageBps } = parseTradeIntent(prompt);
          const amountIn = parseUnits(String(amountInUsdc), 6);
          append(`Coordinator › authorizing a bounded swap · ≤ ${amountInUsdc} USDC → WETH · max ${(slippageBps / 100).toFixed(2)}% slippage…`);
          const bounds = await resolveSwapBounds({ recipient: address, amountIn, slippageBps });
          const swap = await grantSwap({ walletClient, userAddress: address, coordinator, bounds, expiry: expirySeconds ? Math.floor(Date.now() / 1000) + expirySeconds : undefined });
          swapGrantRef.current = swap;
          setSwapAuthorized(true);
          append("Coordinator › swap authorization signed · pair + cap + slippage floor + recipient bound on-chain");
          void registerGrant({
            id: swap.delegationHash,
            user: address,
            kind: "swap",
            label: `Bounded swap · ${amountInUsdc} USDC → WETH`,
            prompt,
            coordinator: coordinator.address,
            token: config.usdc,
            amount: amountIn.toString(),
            expiry: swap.expiry,
            enforcer: config.swapBoundsEnforcer,
            context: swap.context,
          });
        } catch (e) {
          append(`Coordinator › couldn't authorize the swap · ${errMsg(e)}`);
        }
      }
    } catch (e) {
      console.error("[conduit] grant failed →", e);
      append(`Grant failed · ${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
    // Return the fresh grant so callers (e.g. raise-budget-and-rerun) can use it
    // immediately — the grantResult STATE won't be visible in their closure yet.
    return grantedResult;
  };

  // Settlement is async: /settle returns once 1Shot ACCEPTS the redemption, but
  // the tx mines out of band. Poll the facilitator's job until it confirms (or
  // fails) so the card shows the REAL on-chain tx — reliable even if the live
  // SSE stream drops the confirmation event. Keeps the card honest: "settling"
  // until confirmed, then "settled ✓" with the tx (or "failed").
  const pollSettlement = async (correlationId: string, jobId: string) => {
    const deadline = Date.now() + 150_000; // ~2.5 min, matches the relayer window
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      const job = await fetchJob(jobId);
      if (!job) continue;
      if (job.status === "confirmed") {
        setCardStage(correlationId, { stage: "settled", txHash: job.transaction ?? null });
        if (job.transaction) {
          append(`paid ✓ · receipt ${job.transaction.slice(0, 10)}…`);
        }
        return;
      }
      if (job.status === "failed") {
        setCardStage(correlationId, { stage: "failed", reason: job.error ?? "settlement failed" });
        append(`settlement failed · ${job.error ?? "unknown"}`);
        return;
      }
      // pending: a tx hash may appear before final confirmation — show it early.
      if (job.transaction) setCardStage(correlationId, { txHash: job.transaction });
    }
  };

  // The atomic-commission panel has its own settlement state (the SINGLE batch
  // tx). 1Shot returns "pending" first and the tx mines out of band, so poll the
  // job and fill the tx hash → the panel flips from "settling" to a Basescan link.
  const pollAtomicSettlement = async (jobId: string) => {
    const deadline = Date.now() + 150_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      const job = await fetchJob(jobId);
      if (!job) continue;
      if (job.transaction) {
        setAtomicResult((prev) => (prev ? { ...prev, tx: job.transaction ?? prev.tx } : prev));
      }
      if (job.status === "confirmed") {
        if (job.transaction) append(`Payment confirmed ✓ · receipt ${job.transaction.slice(0, 10)}…`);
        return;
      }
      if (job.status === "failed") {
        append(`commission settlement failed · ${job.error ?? "unknown"}`);
        return;
      }
    }
  };

  // Venice report enrichment: prose aggregation (/api/report). The cover is no
  // longer generated separately — when the brief calls for visuals the hired
  // Illustrator's paid image becomes the hero (derived in ReportPanel). Best-
  // effort: failures leave the deterministic sections intact.
  const enrichReport = async (forPrompt: string, sections: ReportSection[]) => {
    append("Coordinator › Venice is writing up your results…");
    try {
      const res = await fetch("/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: forPrompt, sections }),
      });
      if (res.ok) {
        const j = (await res.json()) as { markdown?: string | null };
        if (j.markdown) {
          // Venice writes a tailored H1 — promote it to the panel title and drop
          // it from the body so the heading isn't shown twice.
          const m = j.markdown.match(/^\s*#\s+(.+?)\s*$/m);
          if (m) {
            setReportTitle(m[1].trim());
            setReportMarkdown(j.markdown.replace(m[0], "").trimStart());
          } else {
            setReportMarkdown(j.markdown);
          }
          append("Coordinator › polished by Venice ✓");
        }
      }
    } catch (e) {
      append(`Coordinator › couldn't polish the write-up · ${errMsg(e)}`);
    }
  };

  // Voice input — record the spoken request, transcribe via Venice STT, drop it
  // into the prompt box. Venice is the very first step of the main flow.
  const toggleRecord = async () => {
    if (recording) {
      mediaRecorderRef.current?.stop();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      append("voice › this browser does not support recording");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Pick a container the recorder actually supports AND keep the filename
      // extension matched to it. Chrome/Firefox → webm/opus, Safari → mp4/aac.
      // A mismatched extension or an unsupported requested type can yield audio
      // the transcriber decodes as silence → hallucinated, "always wrong" text.
      const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
      const picked =
        typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported
          ? candidates.find((t) => MediaRecorder.isTypeSupported(t))
          : undefined;
      const rec = picked ? new MediaRecorder(stream, { mimeType: picked }) : new MediaRecorder(stream);
      audioChunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        const mime = rec.mimeType || picked || "audio/webm";
        const blob = new Blob(audioChunksRef.current, { type: mime });
        // Tiny blobs are effectively silence — transcribers hallucinate on those.
        if (blob.size < 1200) {
          append("voice › nothing recorded — hold the button and speak, then release");
          return;
        }
        setTranscribing(true);
        append("voice › transcribing via Venice…");
        try {
          const ext = /mp4|m4a|aac/.test(mime) ? "mp4" : /ogg/.test(mime) ? "ogg" : "webm";
          const form = new FormData();
          form.append("audio", blob, `request.${ext}`);
          const res = await fetch("/api/transcribe", { method: "POST", body: form });
          const json = (await res.json()) as { text?: string; error?: string };
          if (res.ok && json.text) {
            setPrompt(json.text);
            append(`voice › "${json.text}"`);
          } else {
            append(`voice › ${json.error ?? "transcription failed"}`);
          }
        } catch (e) {
          append(`voice › ${errMsg(e)}`);
        } finally {
          setTranscribing(false);
        }
      };
      mediaRecorderRef.current = rec;
      rec.start();
      setRecording(true);
    } catch (e) {
      append(`voice › mic access denied · ${errMsg(e)}`);
    }
  };

  // Run the prompt: coordinator plans, then pays each service through Conduit.
  // `atomic` switches to the ONE-tx commission path (all-or-nothing batch).
  const run = async (opts?: { trimToFit?: boolean; grantOverride?: GrantResult; atomic?: boolean }) => {
    // grantOverride lets the raise-budget path run against a JUST-minted grant
    // whose value isn't in the grantResult state closure yet.
    const activeGrant = opts?.grantOverride ?? grantResult;
    if (busy || !granted || !activeGrant || !coordinatorRef.current) return;
    setBusy(true);
    setCards([]);
    setRevoked(false);
    setReport(null);
    setReportMarkdown(null);
    setReportTitle(null);
    setTradeResult(null);
    setSwapAuthorized(false);
    swapGrantRef.current = null;
    reportRef.current = [];
    setBudgetForecast(null);
    setBudgetPause(null);
    setAtomicResult(null);
    setSpent(0); // each campaign meters its own spend against the period cap
    try {
      // Identical card/report wiring for both the sequential and atomic paths.
      const hooks = {
        log: append,
        onDiscover: (agents: DiscoveredAgent[]) => setMarket(agents),
        onBudgetForecast: (info: { planTotal: bigint; budget: bigint }) => setBudgetForecast(info),
        onPlan: (items: PlannedItem[]) => {
          setCards(
            items.map((i) => ({
              correlationId: i.correlationId,
              service: i.service.id,
              label: i.service.label,
              agent: i.agent,
              priceUsdc: i.service.priceUsdc,
              rationale: i.rationale,
              stage: "queued" as const,
            }))
          );
        },
        onTask: (task: { taskId: string }, agentAddress: `0x${string}`) =>
          setCardStage(task.taskId, { agentAddress, a2a: true }),
        onPayStart: (cid: string) => setCardStage(cid, { stage: "requested" }),
        onResult: (r: ServiceResult) => {
          if (r.ok) {
            setSpent((s) => s + Number(r.amount));
            // Stash the exact settled payload to fuel a real replay attempt.
            if (r.settledPayload && r.resourcePath) {
              lastSettledRef.current = {
                payload: r.settledPayload,
                resourcePath: r.resourcePath,
              };
            }
            const source = (r.output as { source?: string } | undefined)?.source;
            // Honest state: if we don't yet have a tx, the redemption is only
            // ACCEPTED (not mined) — stay "settling" and poll for confirmation.
            setCardStage(r.correlationId, {
              stage: r.txHash ? "settled" : "settling",
              txHash: r.txHash ?? null,
              source,
            });
            if (!r.txHash && r.jobId) {
              void pollSettlement(r.correlationId, r.jobId);
            }
            if (source?.startsWith("venice")) {
              append(`${r.agent} › created by Venice (${source.replace(/^venice:/, "")})`);
            }
            // Collect the purchased output for the aggregated report.
            if (r.output) {
              reportRef.current.push({
                agent: r.agent,
                label: r.service.label,
                priceUsdc: r.service.priceUsdc,
                output: r.output as ReportSection["output"],
                correlationId: r.correlationId,
              });
            }
          } else {
            setCardStage(r.correlationId, { stage: "denied", reason: r.error, budgetCapped: r.budgetCapped });
          }
        },
      };

      const outcome: {
        status: "ok" | "paused-budget" | "failed";
        planTotal?: bigint;
        budget?: bigint;
        budgetCapped?: boolean;
        error?: string;
        totalSpent: bigint;
        plan: PlanItem[];
        settlement?: { jobId?: string; status?: string; transaction?: string | null; confirmedVia?: "webhook" | "poll" | null };
      } = opts?.atomic
        ? await runCommissionAtomic({
            prompt,
            grant: activeGrant,
            coordinator: coordinatorRef.current,
            authorization,
            trimToFit: opts?.trimToFit,
            hooks,
          })
        : await runCampaign({
            prompt,
            grant: activeGrant,
            coordinator: coordinatorRef.current,
            mode,
            authorization,
            trimToFit: opts?.trimToFit,
            hooks,
          });

      // Budget gate tripped: the plan costs more than the grant, so the
      // coordinator stopped BEFORE any payment — nothing was spent. Surface the
      // choice (raise the cap, run within it, or cancel) and bail out early.
      if (outcome.status === "paused-budget") {
        setBudgetPause({ planTotal: outcome.planTotal!, budget: outcome.budget!, atomic: !!opts?.atomic });
        append("Coordinator › stopped — nothing was charged. Add budget or hire a smaller team.");
        return;
      }
      // Clear the auth after the first run consumed it for designation.
      setAuthorization(null);

      // Atomic commission couldn't go through → all-or-nothing, nothing charged.
      // A budget rejection shows the same friendly "add budget / smaller team"
      // choice as the pre-flight pause; anything else is a brief notice.
      if (opts?.atomic && outcome.status === "failed") {
        if (outcome.budgetCapped && outcome.planTotal && outcome.budget) {
          setBudgetPause({ planTotal: outcome.planTotal, budget: outcome.budget, atomic: true });
        } else {
          // Surface the real reason — never just "couldn't complete".
          console.error("[commission] failed:", outcome.error);
          append(`Couldn't complete the hire — ${outcome.error ?? "unknown error"}. Nothing was charged.`);
        }
        return;
      }
      // Atomic success → record the single-tx settlement for the one-tx panel.
      if (opts?.atomic && outcome.status === "ok") {
        const jobId = outcome.settlement?.jobId;
        setAtomicResult({
          tx: outcome.settlement?.transaction ?? null,
          jobId,
          count: outcome.plan.length,
          total: outcome.totalSpent,
          confirmedVia: outcome.settlement?.confirmedVia ?? null,
        });
        // 1Shot returns pending first; poll until the batch tx mines so the
        // panel shows the real Basescan link instead of "settling".
        if (!outcome.settlement?.transaction && jobId) {
          void pollAtomicSettlement(jobId);
        }
      }

      // Aggregate the purchased outputs into the final report.
      if (reportRef.current.length > 0) {
        const sections = [...reportRef.current];
        append("Coordinator › putting your results together…");
        setReportTitle(deriveTitle(prompt));
        setReport(sections);
        append("Results ready ✓");
        // Enrich via Venice (best-effort): prose aggregation + a cover image.
        // Both fall back gracefully — the deterministic sections always render.
        void enrichReport(prompt, sections);
      }

      // TRADE branch (isolated): if the prompt asked for a move and the swap was
      // authorised, execute the bounded swap now — its own step, never folded
      // into the research payment batch.
      if (isTradeIntent(prompt) && swapGrantRef.current) {
        await runTrade(swapGrantRef.current);
      }
    } catch (e) {
      console.error("[run] threw:", e);
      append(`Run failed · ${errMsg(e)}`);
    } finally {
      setBusy(false);
      void refreshBudget(); // reconcile the meter to on-chain truth post-run
      void refreshBalance(); // the team got paid — reflect the new wallet balance
    }
  };

  // Execute the bounded swap the coordinator hired the Trader for. Isolated from
  // the payment path: approve the router once (direct tx, like cancel/revoke),
  // then settle the SwapBounds-bound exactInputSingle through 1Shot. `rogue`
  // crafts a redirect (proceeds → an attacker) → SwapBoundsEnforcer rejects it.
  const runTrade = async (swap: SwapGrant, rogue = false) => {
    if (!coordinatorRef.current || !walletClient || !address) return;
    const b = swap.bounds;
    const tokenOutSymbol = "WETH";
    const amtUsdc = (Number(b.maxAmountIn) / 1e6).toFixed(2);
    const base: TradeResult = {
      stage: "settling", amountIn: b.maxAmountIn, minAmountOut: b.minAmountOut,
      tokenOutSymbol, slippageBps: 100, rogue,
    };
    setTradeResult(base);

    // Surface the Trader as a hired specialist in the feed/canvas (service:"trade"
    // → the canvas renders its SwapBounds caveat). The coordinator "hires" it.
    const correlationId = crypto.randomUUID();
    setCards((cs) => [
      ...cs,
      {
        correlationId,
        service: "trade",
        label: rogue ? "Rogue Trader" : "Trader",
        agent: rogue ? "rogue" : "trade",
        priceUsdc: amtUsdc,
        rationale: rogue
          ? "Tries to redirect the swap proceeds to itself."
          : `Executes the bounded swap · ${amtUsdc} USDC → ${tokenOutSymbol}.`,
        stage: "requested" as CardStage,
        rogueKind: rogue ? ("redirect" as RogueKind) : undefined,
      },
    ]);
    append(rogue
      ? "Coordinator → rogue Trader › redirecting the swap proceeds to itself…"
      : `Coordinator → Trader › execute a bounded swap · ${amtUsdc} USDC → ${tokenOutSymbol}, your account, ≤1% slippage`);

    try {
      // No separate approve tx: the router allowance rides the SAME 1Shot batch as
      // the swap ([approve, swap]), bounded by ApproveBounds → gas in USDC, no ETH.
      setCardStage(correlationId, { stage: "settling" });
      // Any 402 carries the facilitator caps (redeemer/feeCollector/fee quote).
      const req = await fetch402("/services/researcher");
      const built = await buildSwapCommission({
        grant: swap, coordinator: coordinatorRef.current, req,
        amountIn: b.maxAmountIn,
        recipientOverride: rogue ? randomRogueAddr() : undefined,
      });
      const r = await settleSwap(built.paymentPayload, { correlationId, agent: rogue ? "rogue" : "Trader" });
      if (!r.ok) {
        // Expected for the rogue (SwapBounds:wrong-recipient) — the money shot.
        setTradeResult({ ...base, stage: rogue ? "blocked" : "failed", reason: r.error });
        setCardStage(correlationId, { stage: rogue ? "denied" : "failed", reason: r.error });
        append(rogue ? `rogue Trader › BLOCKED on-chain · ${r.error}` : `Trader › swap failed · ${r.error}`);
        return;
      }
      setTradeResult({ ...base, stage: "settling", txHash: r.transaction ?? null });
      setCardStage(correlationId, { stage: "settling", txHash: r.transaction ?? null });
      if (r.jobId) {
        const job = await pollTradeJob(r.jobId);
        const ok = job?.status === "confirmed";
        setTradeResult({
          ...base,
          stage: ok ? "settled" : job?.status === "failed" ? "failed" : "settling",
          txHash: job?.transaction ?? r.transaction ?? null,
          confirmedVia: job?.confirmedVia ?? null,
          reason: job?.error ?? null,
        });
        setCardStage(correlationId, {
          stage: ok ? "settled" : job?.status === "failed" ? "failed" : "settling",
          txHash: job?.transaction ?? r.transaction ?? null,
          reason: job?.error ?? null,
        });
        if (ok) append(`Trader › swap settled ✓ · receipt ${(job?.transaction ?? "").slice(0, 10)}…`);
      }
    } catch (e) {
      setTradeResult({ ...base, stage: "failed", reason: errMsg(e) });
      setCardStage(correlationId, { stage: "failed", reason: errMsg(e) });
      append(`Trader › ${errMsg(e)}`);
    }
  };

  const pollTradeJob = async (jobId: string) => {
    const deadline = Date.now() + 150_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      const job = await fetchJob(jobId);
      if (!job) continue;
      if (job.status === "confirmed" || job.status === "failed") return job;
    }
    return await fetchJob(jobId);
  };

  // The rogue Trader — a click away, like the other rogues. Reuses the signed
  // swap grant but crafts a swap that pays an attacker → blocked on-chain.
  const tryRogueTrade = async () => {
    if (busy || !swapGrantRef.current) return;
    setBusy(true);
    try {
      await runTrade(swapGrantRef.current, true);
    } finally {
      setBusy(false);
    }
  };

  // Pause-panel action: raise the cap to cover the real plan cost (+10% headroom
  // for quote/gas drift), re-grant, then re-run against the FRESH grant. The user
  // re-signs the bigger budget in their wallet; still nothing was spent on the
  // paused attempt.
  const raiseBudgetAndRun = async () => {
    if (!budgetPause || busy) return;
    const neededUsdc = Number(budgetPause.planTotal) / 1e6;
    const suggested = (Math.ceil(neededUsdc * 1.1 * 100) / 100).toFixed(2);
    const wasAtomic = !!budgetPause.atomic;
    setBudgetPause(null);
    setAmountInput(suggested);
    append(`Raising the budget to ${suggested} USDC — approve the new grant in your wallet…`);
    const fresh = await grant();
    if (fresh) await run({ grantOverride: fresh, atomic: wasAtomic });
  };

  // Pause-panel action: keep the highest-priority agents that fit and run only
  // those — a useful partial report that never overflows the budget.
  const runWithinBudget = async () => {
    if (!budgetPause || busy) return;
    const wasAtomic = !!budgetPause.atomic;
    setBudgetPause(null);
    await run({ trimToFit: true, atomic: wasAtomic });
  };

  // The compromised-agent beat: submit a real malicious payment and let Conduit
  // reject it on-chain. Appends a rogue card that goes magenta/denied.
  const tryRogue = async (kind: RogueKind) => {
    if (busy || !granted || !grantResult || !coordinatorRef.current) return;
    if (kind === "replay" && !lastSettledRef.current) {
      append("Hire the team first, then Replay can re-submit a real payment.");
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
        rogueKind: kind,
        attack: { kind },
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
        attack: r.attack ?? { kind },
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

      {/* PERMISSION — full-width setup bar (the prerequisite: grant a bounded
          budget first, then run). Controls lay out horizontally; the budget
          meter + revoke sit in a right rail. */}
      <div className="mx-auto max-w-7xl px-6 pt-8">
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

          <div className="mt-4 flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
            {/* setup / status */}
            <div className="flex-1">
              {!granted || showGrantForm ? (
                <div className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-end">
                  {/* budget */}
                  <label className="flex flex-col gap-1.5 text-sm">
                    <span className="text-white">budget — up to</span>
                    <span className="flex items-center gap-2">
                      <input
                        type="number" min="0" step="0.01" inputMode="decimal"
                        value={amountInput}
                        onChange={(e) => setAmountInput(e.target.value)}
                        disabled={!connected || busy}
                        className="mono w-28 rounded-lg border border-conduit-border bg-transparent px-2 py-1.5 text-white outline-none focus:border-conduit-cyan disabled:opacity-40"
                      />
                      <span className="text-white">USDC</span>
                    </span>
                  </label>
                  {/* expires */}
                  <div className="flex flex-col gap-1.5 text-sm">
                    <span className="text-white">expires</span>
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        type="datetime-local"
                        value={expiryAt}
                        min={toLocalDatetime(Date.now() + 60_000)}
                        onChange={(e) => setExpiryAt(e.target.value)}
                        disabled={!connected || busy}
                        className="mono rounded-lg border border-conduit-border bg-conduit-panel px-2 py-1.5 text-white outline-none focus:border-conduit-cyan disabled:opacity-40"
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
                  </div>
                  {/* grant */}
                  <button
                    onClick={grant}
                    disabled={!connected || busy || needsSmartAccount}
                    className="btn-primary justify-center text-sm disabled:opacity-40 sm:self-end"
                  >
                    {granted ? "Grant new permission" : "Grant permission"}
                  </button>
                  {granted && (
                    <button
                      onClick={() => setShowGrantForm(false)}
                      disabled={busy}
                      className="mono justify-center self-end text-[12px] text-conduit-muted underline-offset-4 hover:text-white hover:underline disabled:opacity-40"
                    >
                      cancel
                    </button>
                  )}
                </div>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-[13px] leading-relaxed text-conduit-muted">
                    Authorizing{" "}
                    <span className="font-semibold text-white">up to {displayAmount} USDC</span> for
                    this task. Expires in <span className="mono text-conduit-cyan">{expiryText}</span>.
                  </p>
                  <button
                    onClick={() => setShowGrantForm(true)}
                    disabled={busy}
                    className="mono rounded-md border border-conduit-border px-2.5 py-1 text-[12px] text-conduit-muted transition-colors hover:border-conduit-cyan/50 hover:text-conduit-cyan disabled:opacity-40"
                  >
                    ↻ New permission
                  </button>
                </div>
              )}
              {!granted && connected && (
                <p className="mt-3 text-[11px] leading-relaxed text-conduit-muted">
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
              {!granted && (
                <p className="mt-3 text-[12px] leading-relaxed text-conduit-muted/80">
                  Authorize an agent budget — erc7715, bound per request, revocable anytime.
                </p>
              )}
            </div>

            {/* wallet balance + budget meter + revoke (right rail) */}
            <div className="w-full lg:w-72 lg:shrink-0">
              <div className="mb-3 flex items-center justify-between rounded-lg border border-conduit-border/60 bg-white/[0.03] px-3 py-2">
                <span className="text-xs text-conduit-muted">Your balance</span>
                <span className="mono text-sm font-semibold text-white">
                  {usdcBalance === null ? "—" : (Number(usdcBalance) / 1e6).toFixed(2)}
                  <span className="ml-1 text-[11px] font-normal text-conduit-muted">USDC</span>
                </span>
              </div>
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
              {granted && (
                <div className="mt-4 border-t border-conduit-border/60 pt-3">
                  <button
                    onClick={revoke}
                    disabled={busy}
                    className="w-full rounded-lg border border-conduit-magenta/40 px-3 py-2 text-xs font-medium text-conduit-magenta transition-colors hover:bg-conduit-magenta/10 disabled:opacity-40"
                  >
                    {busy ? "Working…" : "Cancel budget — stop all agents"}
                  </button>
                  <p className="mt-1.5 text-[11px] leading-relaxed text-conduit-muted/70">
                    Instantly cuts off every agent&rsquo;s access to your budget. Needs a little ETH for the network fee.
                  </p>
                </div>
              )}
            </div>
          </div>
        </section>
      </div>

      {/* PROMPT — full-width bar so the tree below gets the width. Prompt input
          on the left; the hijacked-agent (safety) controls on the right. */}
      <div className="mx-auto max-w-7xl px-6 pt-4">
        <section className="panel p-6">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
            {/* prompt input */}
            <div className="flex-1">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-conduit-muted">
                  Prompt
                </h2>
                <button
                  onClick={toggleRecord}
                  disabled={busy || transcribing}
                  title={recording ? "Stop & transcribe" : "Speak your request (Venice)"}
                  className={`mono flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] transition disabled:opacity-40 ${
                    recording
                      ? "bg-conduit-magenta/20 text-conduit-magenta animate-pulse"
                      : "border border-conduit-border text-conduit-muted hover:text-conduit-cyan"
                  }`}
                >
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="9" y="2" width="6" height="11" rx="3" />
                    <path d="M5 10a7 7 0 0 0 14 0" />
                    <line x1="12" y1="19" x2="12" y2="22" />
                  </svg>
                  {recording ? "Recording… stop" : transcribing ? "Transcribing…" : "Speak"}
                </button>
              </div>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                disabled={busy}
                rows={2}
                className="mono mt-3 w-full resize-none rounded-lg border border-conduit-border bg-transparent px-3 py-2 text-[13px] text-white outline-none focus:border-conduit-cyan disabled:opacity-40"
              />
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <button
                  onClick={() => run({ atomic: true })}
                  disabled={!granted || busy || !!runBlock}
                  title="Hire everyone together in a single payment. If your budget can't cover the whole team, no one is charged."
                  className="btn-primary justify-center px-8 text-sm disabled:opacity-40"
                >
                  {busy ? "Hiring…" : "Hire the team"}
                </button>
                <p className="text-[10px] text-conduit-muted/70">
                  <span className="text-conduit-violet">✦</span> everyone paid together · all-or-nothing · Venice-powered
                </p>
              </div>
              {runBlock && (
                <p className="mt-2 text-[11px] leading-relaxed text-conduit-magenta">
                  {runBlock}
                  {expired && (
                    <span className="mt-1 block text-conduit-muted">
                      Grant a new permission to continue.
                    </span>
                  )}
                </p>
              )}
            </div>

            {/* The compromised-agent (safety) beat — real on-chain rejections. */}
            <div className="w-full lg:w-80 lg:shrink-0 lg:border-l lg:border-conduit-border/60 lg:pl-6">
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
                {/* Trade-specific rogue — only when a swap was authorised. */}
                {swapAuthorized && (
                  <button
                    onClick={() => void tryRogueTrade()}
                    disabled={busy}
                    className="rounded-lg border border-conduit-magenta/40 px-2.5 py-1.5 text-xs font-medium text-conduit-magenta transition-colors hover:bg-conduit-magenta/10 disabled:opacity-40"
                  >
                    Redirect swap
                  </button>
                )}
              </div>
            </div>
          </div>
        </section>
      </div>

      <div className="mx-auto grid max-w-7xl gap-6 px-6 pb-8 pt-6 lg:grid-cols-12">
        {/* CENTER: the live event feed — the star (widened) */}
        <div className="lg:col-span-9">
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
                market={market.map((m) => ({
                  id: m.id, name: m.name, role: m.role, veniceEndpoint: m.veniceEndpoint,
                  priceUsdc: m.priceUsdc, agentId: m.agentId, source: m.source,
                }))}
                mode={mode}
                budget={{
                  capUsdc: displayAmount,
                  spentUsdc: (spentClamped / 1e6).toFixed(2),
                  remainingUsdc,
                  pct,
                  expiryText,
                }}
                revoked={revoked}
                busy={busy}
              />
            </div>
          </section>

          {/* Pre-flight budget gate — plan cost > budget, so the run paused
              before spending. The user raises the cap or runs within it. */}
          {budgetPause && (
            <BudgetPausePanel
              pause={budgetPause}
              busy={busy}
              onRaise={raiseBudgetAndRun}
              onTrim={runWithinBudget}
              onCancel={() => setBudgetPause(null)}
            />
          )}

          {/* Budget-cap safety beat — the budget enforcer blocked an overflow
              payment ON-CHAIN (only happens if a payment slipped past the gate,
              e.g. concurrent agents draining one budget). */}
          {!budgetPause && cards.some((c) => c.budgetCapped) && (
            <BudgetCapPanel cards={cards} forecast={budgetForecast} capUsdc={displayAmount} />
          )}

          {/* Atomic-commission proof: the whole team paid in ONE transaction. */}
          {atomicResult && (
            <AtomicCommissionPanel result={atomicResult} explorerBase={config.explorerUrl} />
          )}

          {/* The payoff: the aggregated report assembled from purchased outputs */}
          {report && (
            <ReportPanel
              sections={report}
              title={reportTitle}
              markdown={reportMarkdown}
              cards={cards}
              tradeNote={
                tradeResult && !tradeResult.rogue
                  ? `moved ${(Number(tradeResult.amountIn) / 1e6).toFixed(2)} USDC → ${tradeResult.tokenOutSymbol}${tradeResult.stage === "settled" ? " ✓" : "…"}`
                  : null
              }
            />
          )}

          {/* The trade payoff: the executed bounded swap (isolated trade branch). */}
          {tradeResult && <TradeReceipt result={tradeResult} />}
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

// --- report panel ----------------------------------------------------------

/** The atomic-commission proof — the whole team was paid in ONE redeemDelegations
 *  batch. All-or-nothing made hard: either every agent settled in this single tx
 *  or none did. The headline differentiator, with the on-chain receipt. */
function AtomicCommissionPanel({
  result,
  explorerBase,
}: {
  result: { tx: string | null; jobId?: string; count: number; total: bigint; confirmedVia?: "webhook" | "poll" | null };
  explorerBase: string;
}) {
  const usd = (a: bigint) => (Number(a) / 1e6).toFixed(2);
  const pending = !result.tx;
  return (
    <section className="panel reveal mt-6 border-conduit-violet/40 p-6">
      <div className="flex items-center gap-2.5">
        <span className="grid h-8 w-8 place-items-center rounded-full bg-conduit-violet/15 text-conduit-violet" aria-hidden>
          ✓
        </span>
        <h2 className="text-base font-semibold text-white">
          {pending ? "Hiring your team…" : "Your team is hired"}
        </h2>
      </div>
      <p className="mt-2 text-[13px] leading-relaxed text-conduit-muted">
        All <span className="font-semibold text-white">{result.count} specialists</span> were paid{" "}
        <span className="font-semibold text-white">{usd(result.total)} USDC</span> together in{" "}
        <span className="text-white">one payment</span>, sharing a single network fee for the whole
        team. It&apos;s all-or-nothing: if your budget couldn&apos;t cover everyone, no one would have
        been charged — so you never pay for a half-finished job.
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-2 text-[12px]">
        <span className="rounded-full bg-white/5 px-2.5 py-1 text-conduit-muted">
          <span className="font-semibold text-white">{result.count}</span> specialists
        </span>
        <span className="rounded-full bg-white/5 px-2.5 py-1 text-conduit-muted">
          <span className="font-semibold text-white">{usd(result.total)} USDC</span> total
        </span>
        <span className="rounded-full bg-white/5 px-2.5 py-1 text-conduit-muted">
          <span className="font-semibold text-white">1</span> shared fee
        </span>
        {result.confirmedVia === "webhook" && (
          <span className="rounded-full bg-conduit-violet/10 px-2.5 py-1 font-medium text-conduit-violet" title="Settlement confirmed by 1Shot's Ed25519-signed webhook, not polling.">
            ✓ confirmed via 1Shot signed webhook
          </span>
        )}
        {result.tx ? (
          <a
            href={`${explorerBase}/tx/${result.tx}`}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-full bg-conduit-cyan/10 px-2.5 py-1 font-medium text-conduit-cyan transition hover:bg-conduit-cyan/20"
          >
            View receipt ↗
          </a>
        ) : (
          <span className="flex items-center gap-1.5 rounded-full bg-white/5 px-2.5 py-1 text-conduit-muted/80">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-conduit-violet" />
            Confirming payment…
          </span>
        )}
      </div>
    </section>
  );
}

/** The pre-flight budget gate — the plan costs more than the grant, so the
 *  coordinator STOPPED before any payment. Nothing was spent. The user chooses:
 *  raise the cap (re-grant sized to the plan), run within the budget (trim to
 *  the affordable subset), or cancel. This is the "no wasted USDC" beat. */
function BudgetPausePanel({
  pause,
  busy,
  onRaise,
  onTrim,
  onCancel,
}: {
  pause: { planTotal: bigint; budget: bigint };
  busy: boolean;
  onRaise: () => void;
  onTrim: () => void;
  onCancel: () => void;
}) {
  const usd = (a: bigint) => (Number(a) / 1e6).toFixed(2);
  return (
    <section className="panel reveal mt-6 border-amber-400/40 p-6">
      <div className="flex items-center gap-2.5">
        <span className="grid h-8 w-8 place-items-center rounded-full bg-amber-400/15 text-amber-300" aria-hidden>
          !
        </span>
        <h2 className="text-base font-semibold text-white">Over budget — nothing was charged</h2>
      </div>
      <p className="mt-2 text-[13px] leading-relaxed text-conduit-muted">
        This team would cost{" "}
        <span className="font-semibold text-amber-300">{usd(pause.planTotal)} USDC</span>, but your
        budget is <span className="font-semibold text-white">{usd(pause.budget)} USDC</span>. We
        checked the full price <span className="text-white">before charging anything</span>, so
        nothing has left your wallet. You can add a little budget, or hire a smaller team that fits.
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          onClick={onRaise}
          disabled={busy}
          className="rounded-lg border border-conduit-cyan/50 bg-conduit-cyan/10 px-3.5 py-2 text-[13px] font-medium text-conduit-cyan transition hover:bg-conduit-cyan/20 disabled:opacity-50"
        >
          Add budget &amp; try again
        </button>
        <button
          onClick={onTrim}
          disabled={busy}
          className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-3.5 py-2 text-[13px] font-medium text-amber-300 transition hover:bg-amber-400/20 disabled:opacity-50"
        >
          Hire a smaller team that fits
        </button>
        <button
          onClick={onCancel}
          disabled={busy}
          className="rounded-lg border border-conduit-muted/30 px-3.5 py-2 text-[13px] font-medium text-conduit-muted transition hover:text-white disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </section>
  );
}

/** The budget-cap safety beat — the ERC20PeriodTransferEnforcer blocks payments
 *  that would exceed the granted budget. Styled amber (a limit reached), distinct
 *  from the magenta rogue/attack beat. */
function BudgetCapPanel({
  cards,
  forecast,
  capUsdc,
}: {
  cards: FeedCard[];
  forecast: { planTotal: bigint; budget: bigint } | null;
  capUsdc: string;
}) {
  const blocked = cards.filter((c) => c.budgetCapped);
  const hired = cards.filter((c) => c.stage === "settled" || c.stage === "settling");
  const usd = (a: bigint) => (Number(a) / 1e6).toFixed(2);
  return (
    <section className="panel reveal mt-6 border-amber-400/40 p-6">
      <div className="flex items-center gap-2">
        <span aria-hidden>🛡</span>
        <h2 className="text-base font-semibold text-white">Budget cap reached</h2>
        <span className="mono rounded bg-amber-400/15 px-2 py-0.5 text-[10px] text-amber-300">
          ERC20PeriodTransferEnforcer
        </span>
      </div>
      <p className="mt-1.5 text-[13px] leading-relaxed text-conduit-muted">
        The coordinator tried to hire more than your{" "}
        <span className="font-semibold text-white">{capUsdc} USDC</span> budget allows. The budget
        cap blocked the overflow payments <span className="text-white">on-chain</span> — a
        compromised or over-eager agent can never spend beyond what you granted.
      </p>
      {forecast && (
        <p className="mono mt-2 text-[12px] text-conduit-muted">
          plan needed <span className="text-amber-300">{usd(forecast.planTotal)} USDC</span> · budget{" "}
          <span className="text-white">{usd(forecast.budget)} USDC</span>
        </p>
      )}
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <p className="text-[11px] uppercase tracking-wide text-conduit-muted/70">
            ✓ Hired within budget ({hired.length})
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {hired.map((c) => (
              <span key={c.correlationId} className="mono rounded-md border border-conduit-cyan/40 px-2 py-1 text-[11px] text-conduit-cyan">
                {c.label} · {c.priceUsdc}
              </span>
            ))}
            {hired.length === 0 && <span className="text-[11px] text-conduit-muted/60">—</span>}
          </div>
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-wide text-conduit-muted/70">
            ✋ Blocked by the cap ({blocked.length})
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {blocked.map((c) => (
              <span key={c.correlationId} className="mono rounded-md border border-amber-400/40 px-2 py-1 text-[11px] text-amber-300">
                {c.label} · {c.priceUsdc}
              </span>
            ))}
            {blocked.length === 0 && <span className="text-[11px] text-conduit-muted/60">none yet</span>}
          </div>
        </div>
      </div>
    </section>
  );
}

/** A concise, presentable deliverable title derived from the user's prompt.
 *  Used as the report heading + cover theme before Venice's H1 upgrades it. */
function deriveTitle(prompt: string): string {
  let t = (prompt || "").trim();
  // Take just the first clause — briefs often read "Create X — then do Y, Z".
  t = t.split(/[\n.—–|]| - /)[0].trim();
  // Drop the imperative lead-in so the title reads as a thing, not a command.
  t = t.replace(/^(please\s+)?(create|generate|write|make|design|build|produce|prepare|put together|draft|compose)\s+(me\s+)?(an?\s+|the\s+)?/i, "");
  if (!t) return "Your Deliverable";
  // Cap length on a word boundary.
  if (t.length > 64) t = t.slice(0, 64).replace(/\s+\S*$/, "") + "…";
  return t.charAt(0).toUpperCase() + t.slice(1);
}

const REPORT_HEADINGS: Record<string, string> = {
  research: "Research",
  copy: "Brief",
  analysis: "Analysis",
  onchain: "On-chain Data",
  image: "Cover",
  voice: "Voiceover",
};

/** The executed (or blocked) bounded swap — the trade payoff + its SwapBounds caveat. */
function TradeReceipt({ result: r }: { result: TradeResult }) {
  const [open, setOpen] = useState(false);
  const amountInUsdc = (Number(r.amountIn) / 1e6).toFixed(2);
  const minOut = formatUnits(r.minAmountOut, 18); // WETH (18dp)
  const blocked = r.stage === "blocked";
  const settled = r.stage === "settled";
  const failed = r.stage === "failed";
  const badge = blocked
    ? { cls: "bg-conduit-magenta/15 text-conduit-magenta", text: "✗ blocked on-chain" }
    : settled
      ? { cls: "bg-conduit-cyan/15 text-conduit-cyan", text: "✓ executed" }
      : failed
        ? { cls: "bg-conduit-magenta/15 text-conduit-magenta", text: "⚠ failed" }
        : { cls: "bg-conduit-violet/15 text-conduit-violet animate-pulse", text: r.stage === "approving" ? "approving venue…" : "settling…" };
  const binding: InspectorBinding = {
    kind: "swap",
    enforcerName: blocked ? "SwapBoundsEnforcer (violated)" : "SwapBoundsEnforcer",
    enforcerAddr: config.swapBoundsEnforcer,
    violated: blocked,
    terms: [
      { label: "max in", value: `${amountInUsdc} USDC` },
      { label: "min out", value: `≥ ${minOut} ${r.tokenOutSymbol}` },
      { label: "slippage", value: `≤ ${(r.slippageBps / 100).toFixed(2)}%` },
      { label: "to", value: "your account" },
    ],
  };
  return (
    <section className="panel reveal mt-6 p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold tracking-tight text-white">
          {r.rogue ? "Rogue trade attempt" : "Trade executed"}
        </h2>
        <span className={`mono rounded-md px-2 py-0.5 text-[11px] ${badge.cls}`}>{badge.text}</span>
      </div>
      <p className="mt-1 text-[12px] leading-relaxed text-conduit-muted">
        {blocked
          ? "A hijacked Trader tried to redirect the swap proceeds to itself — SwapBounds rejected it on-chain before any funds moved."
          : `Moved ${amountInUsdc} USDC → ${r.tokenOutSymbol} on Uniswap, proceeds to your account, slippage floor enforced by your signature.`}
      </p>
      <div className="mono mt-4 flex flex-wrap gap-x-6 gap-y-1 text-[12px]">
        <span className="text-conduit-muted">in <span className="text-white">{amountInUsdc} USDC</span></span>
        <span className="text-conduit-muted">→ out <span className="text-white">≥ {minOut} {r.tokenOutSymbol}</span></span>
        <span className="text-conduit-muted">slippage <span className="text-white">≤ {(r.slippageBps / 100).toFixed(2)}%</span></span>
        <span className="text-conduit-muted">to <span className="text-white">you</span></span>
      </div>
      {settled && r.txHash && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <a
            href={`${config.explorerUrl}/tx/${r.txHash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="mono text-[11px] text-conduit-cyan underline-offset-2 hover:underline"
          >
            receipt {r.txHash.slice(0, 10)}… ↗
          </a>
          {r.confirmedVia === "webhook" && (
            <span className="mono rounded bg-conduit-cyan/15 px-1.5 py-0.5 text-[10px] text-conduit-cyan">
              ✓ confirmed via 1Shot signed webhook
            </span>
          )}
        </div>
      )}
      {blocked && r.reason && <p className="mono mt-2 text-[11px] text-conduit-magenta/80">revert: {r.reason}</p>}
      <button
        onClick={() => setOpen((o) => !o)}
        className="mono mt-3 text-[11px] text-conduit-muted underline-offset-4 hover:text-conduit-cyan"
      >
        {open ? "▾ hide caveat" : "▸ inspect caveat"}
      </button>
      {open && <Erc7710Inspector binding={binding} />}
    </section>
  );
}

function ReportPanel({
  sections,
  title,
  markdown,
  cards,
  tradeNote,
}: {
  sections: ReportSection[];
  title?: string | null;
  markdown?: string | null;
  cards: FeedCard[];
  /** "Action taken" line when the run also executed a trade (see receipt below). */
  tradeNote?: string | null;
}) {
  const total = sections.reduce((s, x) => s + (Number(x.priceUsdc) || 0), 0);
  // The hero is the purchased Illustrator image (when the brief called for one) —
  // not a separately generated cover. No image agent hired → no hero.
  const imageSec = sections.find(
    (s) => s.agent === "image" && typeof s.output?.content === "string" && s.output.content.startsWith("data:")
  );
  const cover = imageSec?.output?.content as string | undefined;
  // Live settlement state of the payments behind this report (Option 2): the
  // report is delivered on accept, then earns its "settled on-chain" badge as
  // each payment confirms via pollSettlement.
  const cardFor = (cid: string) => cards.find((c) => c.correlationId === cid);
  const states = sections.map((s) => cardFor(s.correlationId));
  const txCount = states.filter((c) => c?.stage === "settled" && c?.txHash).length;
  const allSettled = states.length > 0 && states.every((c) => c?.stage === "settled");
  const anyFailed = states.some((c) => c?.stage === "failed");
  const settleBadge = allSettled
    ? { cls: "bg-conduit-cyan/15 text-conduit-cyan", text: `✓ paid · ${txCount} receipt${txCount === 1 ? "" : "s"}` }
    : anyFailed
      ? { cls: "bg-conduit-magenta/15 text-conduit-magenta", text: "⚠ payment issue" }
      : { cls: "bg-conduit-violet/15 text-conduit-violet animate-pulse", text: "delivered · confirming payment…" };
  return (
    <section className="panel reveal mt-6 p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold tracking-tight text-white">
          {title || "Your Deliverable"}
        </h2>
        <span className={`mono rounded-md px-2 py-0.5 text-[11px] ${settleBadge.cls}`}>
          {settleBadge.text}
        </span>
      </div>
      <p className="mt-1 text-[12px] text-conduit-muted">
        Assembled by the coordinator from {sections.length} agent
        {sections.length === 1 ? "" : "s"} purchased through Conduit.
      </p>

      {/* The product payoff: the Illustrator agent's purchased image, promoted
          to the hero. Only present when the brief actually hired an illustrator. */}
      {cover && (
        <div className="relative mt-4 overflow-hidden rounded-lg border border-conduit-border">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={cover} alt="Report cover" className="h-44 w-full object-cover" />
          <span className="mono absolute bottom-2 right-2 rounded bg-black/60 px-1.5 py-0.5 text-[9px] text-conduit-cyan">
            Illustrator · Venice image
          </span>
        </div>
      )}

      {/* Venice-aggregated prose (best-effort). Falls back to raw sections. */}
      {markdown ? (
        <>
          <div className="mt-5 flex items-center gap-2">
            <span className="mono rounded bg-conduit-violet/15 px-1.5 py-0.5 text-[10px] text-conduit-violet">
              ✦ written by Venice
            </span>
          </div>
          <div className="mt-2">
            <MiniMarkdown text={markdown} />
          </div>
          <details className="mt-5 border-t border-conduit-border/60 pt-3">
            <summary className="mono cursor-pointer text-[11px] text-conduit-muted hover:text-conduit-cyan">
              purchased sources ({sections.length})
            </summary>
            <div className="mt-3 space-y-4">
              {sections.map((sec, i) => (
                <ReportSectionRow key={i} sec={sec} card={cardFor(sec.correlationId)} heroed={sec === imageSec} />
              ))}
            </div>
          </details>
        </>
      ) : (
        <div className="mt-5 space-y-5">
          {sections.map((sec, i) => (
            <ReportSectionRow key={i} sec={sec} card={cardFor(sec.correlationId)} heroed={sec === imageSec} />
          ))}
        </div>
      )}

      {tradeNote && (
        <div className="mt-5 rounded-lg border border-conduit-cyan/30 bg-conduit-cyan/[0.04] px-3 py-2 text-[12px] text-conduit-muted">
          <span className="mono text-conduit-cyan">↪ Action taken</span> · {tradeNote} <span className="text-conduit-muted/60">(see the trade receipt below)</span>
        </div>
      )}

      <div className="mono mt-6 flex items-center justify-between border-t border-conduit-border/60 pt-3 text-[12px]">
        <span className="text-conduit-muted">
          {sections.map((s) => `${s.label.split(" ")[0]} ${s.priceUsdc}`).join(" · ")}
        </span>
        <span className="text-white">Total spent: {total.toFixed(2)} USDC</span>
      </div>
    </section>
  );
}

function ReportSectionRow({ sec, card, heroed }: { sec: ReportSection; card?: FeedCard; heroed?: boolean }) {
  const settled = card?.stage === "settled" && !!card.txHash;
  return (
    <div>
      <h3 className="text-sm font-semibold text-white">
        {REPORT_HEADINGS[sec.agent] ?? sec.label}
        <span className="mono ml-2 text-[10px] font-normal text-conduit-muted">
          via {sec.label} · {sec.priceUsdc} USDC
          {sec.output?.source ? ` · ${sec.output.source}` : ""}
        </span>
        {settled ? (
          <a
            href={`${config.explorerUrl}/tx/${card!.txHash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="mono ml-2 text-[10px] font-normal text-conduit-cyan underline-offset-2 hover:underline"
          >
            settled ✓ tx ↗
          </a>
        ) : card?.stage === "failed" ? (
          <span className="mono ml-2 text-[10px] font-normal text-conduit-magenta">settlement failed</span>
        ) : (
          <span className="mono ml-2 text-[10px] font-normal text-conduit-violet">settling…</span>
        )}
      </h3>
      <div className="mt-1.5 text-[13px] leading-relaxed text-conduit-muted">
        {heroed ? (
          <p className="text-[12px] text-conduit-muted/70">↑ shown as the cover above</p>
        ) : (
          <ReportOutput output={sec.output} />
        )}
      </div>
    </div>
  );
}

/** Minimal, dependency-free markdown → JSX. Handles the subset Venice emits:
 *  #/##/### headings, - bullets, **bold**, and paragraphs. No raw HTML. */
function MiniMarkdown({ text }: { text: string }) {
  const lines = text.replace(/\r/g, "").split("\n");
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  const flushList = (key: string) => {
    if (list.length) {
      blocks.push(
        <ul key={key} className="my-2 list-disc space-y-1 pl-5 text-[13px] text-conduit-muted">
          {list.map((it, i) => (
            <li key={i}>{inlineBold(it)}</li>
          ))}
        </ul>
      );
      list = [];
    }
  };
  lines.forEach((raw, idx) => {
    const line = raw.trimEnd();
    if (/^#\s+/.test(line)) {
      flushList(`l${idx}`);
      blocks.push(
        <h3 key={idx} className="mt-3 text-base font-semibold text-white">
          {inlineBold(line.replace(/^#\s+/, ""))}
        </h3>
      );
    } else if (/^##\s+/.test(line)) {
      flushList(`l${idx}`);
      blocks.push(
        <h4 key={idx} className="mt-3 text-sm font-semibold text-white">
          {inlineBold(line.replace(/^#{2}\s+/, ""))}
        </h4>
      );
    } else if (/^###\s+/.test(line)) {
      flushList(`l${idx}`);
      blocks.push(
        <h5 key={idx} className="mt-2 text-[13px] font-semibold text-conduit-cyan">
          {inlineBold(line.replace(/^#{3}\s+/, ""))}
        </h5>
      );
    } else if (/^[-*]\s+/.test(line)) {
      list.push(line.replace(/^[-*]\s+/, ""));
    } else if (line.trim() === "") {
      flushList(`l${idx}`);
    } else {
      flushList(`l${idx}`);
      blocks.push(
        <p key={idx} className="my-2 text-[13px] leading-relaxed text-conduit-muted">
          {inlineBold(line)}
        </p>
      );
    }
  });
  flushList("last");
  return <div>{blocks}</div>;
}

/** Render **bold** spans within a line of text. */
function inlineBold(text: string): ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((p, i) =>
    /^\*\*[^*]+\*\*$/.test(p) ? (
      <strong key={i} className="text-white">
        {p.slice(2, -2)}
      </strong>
    ) : (
      <span key={i}>{p}</span>
    )
  );
}

function ReportOutput({ output }: { output: ReportSection["output"] }) {
  const content = output?.content;
  // Illustrator → a cover image (data URL).
  if (output?.type === "image") {
    if (typeof content === "string" && content.startsWith("data:")) {
      // eslint-disable-next-line @next/next/no-img-element
      return <img src={content} alt="Cover" className="mt-1 max-h-64 w-full rounded-lg border border-conduit-border object-cover" />;
    }
    return <p className="text-[12px] text-conduit-muted/70">image unavailable (no Venice key/credits)</p>;
  }
  // Narrator → a playable voiceover (data URL) + transcript.
  if (output?.type === "audio") {
    const transcript = output?.transcript;
    if (typeof content === "string" && content.startsWith("data:")) {
      return (
        <div>
          <audio controls src={content} className="w-full" />
          {transcript && <p className="mt-1 text-[12px] italic text-conduit-muted/80">“{transcript}”</p>}
        </div>
      );
    }
    return <p className="text-[12px] text-conduit-muted/70">{transcript ? `“${transcript}”` : "voiceover unavailable (no Venice key/credits)"}</p>;
  }
  if (output?.type === "data" && content && typeof content === "object") {
    return (
      <ul className="mono space-y-0.5 text-[12px]">
        {Object.entries(content as Record<string, unknown>).map(([k, v]) => (
          <li key={k} className="flex justify-between gap-3">
            <span className="text-conduit-muted/70">{k}</span>
            <span className="text-white">{String(v)}</span>
          </li>
        ))}
      </ul>
    );
  }
  if (typeof content === "string") return <p>{content}</p>;
  return <pre className="mono whitespace-pre-wrap text-[11px]">{JSON.stringify(content, null, 2)}</pre>;
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

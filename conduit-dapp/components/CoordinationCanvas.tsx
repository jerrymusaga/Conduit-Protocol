"use client";

/**
 * The A2A coordination canvas — the hero of the one-shot console.
 *
 * Renders the live agent tree as a deterministic top-down diagram (no graph
 * physics, so it never flakes in a recording):
 *
 *      YOU (one bounded permission, draining)
 *        └─ COORDINATOR
 *             ├─ specialist  ─┐
 *             ├─ specialist  ─┤→  CONDUIT GATE (verify caveat → settle) → delivered
 *             └─ specialist  ─┘
 *
 * The story it tells at a glance: one permission, many agents, each on a NARROW
 * intent-bound A2A edge, every payment funneled through Conduit's gate — and a
 * hijacked agent stopped dead at that gate. Click any agent to drill into the
 * ERC-7710 redemption (delegation + on-chain proof).
 */
import { useState } from "react";
import { config } from "@/lib/config";
import { Erc7710Inspector, type InspectorBinding } from "./Erc7710Inspector";

export interface CanvasCard {
  correlationId: string;
  service: string;
  label: string;
  agent: string;
  priceUsdc: string;
  rationale: string;
  stage: "queued" | "requested" | "allowed" | "denied" | "settling" | "settled" | "failed";
  reason?: string | null;
  txHash?: string | null;
  agentAddress?: string;
  a2a?: boolean;
}

interface Budget {
  capUsdc: string;
  spentUsdc: string;
  remainingUsdc: string;
  pct: number;
  expiryText: string;
}

const CYAN = "#00E5FF";
const VIOLET = "#7C3AED";
const MAGENTA = "#EC4899";

function short(a?: string | null) {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—";
}

type Phase = {
  accent: string;
  working: boolean;
  blocked: boolean;
  done: boolean;
  gate: string;
  service: string;
};

function phaseOf(stage: CanvasCard["stage"]): Phase {
  switch (stage) {
    case "queued":
      return { accent: "#5b6472", working: false, blocked: false, done: false, gate: "—", service: "queued" };
    case "requested":
      return { accent: VIOLET, working: true, blocked: false, done: false, gate: "checking…", service: "—" };
    case "allowed":
      return { accent: VIOLET, working: true, blocked: false, done: false, gate: "caveat ✓", service: "settling…" };
    case "settling":
      return { accent: VIOLET, working: true, blocked: false, done: false, gate: "caveat ✓", service: "settling…" };
    case "settled":
      return { accent: CYAN, working: false, blocked: false, done: true, gate: "caveat ✓", service: "delivered ✓" };
    case "denied":
    case "failed":
      return { accent: MAGENTA, working: false, blocked: true, done: false, gate: "BLOCKED ✗", service: "—" };
  }
}

export function CoordinationCanvas({
  userAddress,
  coordinatorAddress,
  cards,
  mode,
  budget,
  revoked = false,
}: {
  userAddress?: string | null;
  coordinatorAddress?: string | null;
  cards: CanvasCard[];
  mode: "a2a" | "looped";
  budget: Budget;
  revoked?: boolean;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const selectedCard = cards.find((c) => c.correlationId === selected) ?? null;
  const dim = revoked ? "opacity-30 grayscale transition-all duration-700" : "transition-all duration-500";

  if (cards.length === 0) {
    return (
      <div className="flex min-h-[460px] flex-col items-center justify-center text-center">
        <Node kind="you" label="YOU" sub={`one permission · ≤${budget.capUsdc} USDC`} accent={CYAN} />
        <Connector />
        <Node kind="coordinator" label="COORDINATOR" sub="waiting for a prompt" accent="#5b6472" idle />
        <p className="mx-auto mt-8 max-w-md text-[12px] leading-relaxed text-conduit-muted/70">
          Enter a prompt and hit Run. The coordinator will hire specialist agents
          (A2A) and pay each through Conduit — every payment bound so a hijacked
          agent can&rsquo;t misuse your one permission.
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-[460px] py-2">
      {/* YOU — the one permission, draining */}
      <div className={`flex flex-col items-center ${dim}`}>
        <div className="w-64 rounded-xl border px-4 py-3" style={{ borderColor: `${CYAN}55`, background: `${CYAN}0a` }}>
          <div className="flex items-center justify-between">
            <span className="mono text-[12px] font-semibold text-white">● YOU</span>
            <span className="mono text-[10px] text-conduit-muted">{short(userAddress)}</span>
          </div>
          <div className="mt-1 flex items-center justify-between text-[10px] text-conduit-muted">
            <span>one ERC-7715 permission</span>
            <span className="mono">expires {budget.expiryText}</span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/5">
            <div className="h-full rounded-full" style={{ width: `${budget.pct}%`, background: "linear-gradient(90deg,#00E5FF,#7C3AED,#EC4899)" }} />
          </div>
          <div className="mt-1 flex justify-between text-[10px] text-conduit-muted">
            <span className="mono">used {budget.spentUsdc}</span>
            <span className="mono text-white">{budget.remainingUsdc} left of {budget.capUsdc}</span>
          </div>
        </div>
        <EdgeLabel text={`grant ≤${budget.capUsdc} USDC / period`} />
        <Connector />
        {/* COORDINATOR */}
        <Node kind="coordinator" label="◆ COORDINATOR" sub={short(coordinatorAddress)} accent={VIOLET} />
        <p className="mt-2 text-[10px] uppercase tracking-wide text-conduit-muted/70">
          hires {cards.filter((c) => c.agent !== "rogue").length} specialist{cards.filter((c) => c.agent !== "rogue").length === 1 ? "" : "s"} · {mode === "a2a" ? "3-hop A2A" : "direct (2-hop)"}
        </p>
        <Connector />
      </div>

      {/* SPECIALISTS row */}
      <div className={`flex flex-wrap items-stretch justify-center gap-3 ${dim}`}>
        {cards.map((c, i) => (
          <SpecialistColumn
            key={c.correlationId}
            card={c}
            index={i}
            mode={mode}
            selected={selected === c.correlationId}
            onSelect={() => setSelected(selected === c.correlationId ? null : c.correlationId)}
          />
        ))}
      </div>

      {/* CONDUIT GATE band */}
      <div className={`relative mx-auto mt-3 max-w-3xl ${dim}`}>
        <div
          className="rounded-lg border px-4 py-2 text-center"
          style={{ borderColor: `${CYAN}66`, background: `${CYAN}0d` }}
        >
          <span className="mono text-[11px] font-semibold tracking-wide" style={{ color: CYAN }}>
            ╪ CONDUIT GATE ╪
          </span>
          <span className="mono ml-2 text-[10px] text-conduit-muted">
            verify caveat → settle · gas in USDC via 1Shot
          </span>
        </div>
      </div>

      {revoked && (
        <p className="mt-4 text-center text-[12px] font-semibold text-conduit-magenta">
          ⏻ Permission revoked — every agent under it is dead on-chain.
        </p>
      )}

      {/* drill-down: the ERC-7710 redemption + A2A envelope for the picked agent */}
      {selectedCard && (
        <div className="mx-auto mt-5 max-w-2xl">
          <div className="panel p-4">
            <div className="flex items-center justify-between">
              <span className="mono text-[12px] font-semibold text-white">
                {selectedCard.agent === "rogue" ? "rogue agent" : `${selectedCard.agent} agent`} → {selectedCard.label}
              </span>
              <button onClick={() => setSelected(null)} className="text-[11px] text-conduit-muted hover:text-white">close ✕</button>
            </div>
            {/* A2A envelope */}
            <div className="mono mt-3 rounded-lg border border-conduit-border/50 bg-black/20 p-3 text-[11px]">
              <p className="mb-1.5 uppercase tracking-wide text-conduit-muted/60">A2A task envelope</p>
              <Line k="from" v="coordinator" />
              <Line k="to" v={selectedCard.a2a ? `specialist ${short(selectedCard.agentAddress)}` : "coordinator (direct)"} />
              <Line k="task" v={selectedCard.rationale} />
              <Line k="budget cap" v={`≤ ${selectedCard.priceUsdc} USDC · intent-bound`} />
            </div>
            <Erc7710Inspector
              binding={bindingFor(selectedCard)}
              txHash={selectedCard.txHash}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function bindingFor(c: CanvasCard): InspectorBinding {
  return {
    enforcerName: c.agent === "rogue" ? "X402ReceiptEnforcer (violated)" : "X402ReceiptEnforcer",
    enforcerAddr: config.receiptEnforcer,
    boundSummary:
      c.priceUsdc === "—"
        ? "one exact request · recipient + amount + intent"
        : `${c.priceUsdc} USDC → bound recipient · one-shot (intent-locked)`,
  };
}

function SpecialistColumn({
  card,
  index,
  mode,
  selected,
  onSelect,
}: {
  card: CanvasCard;
  index: number;
  mode: "a2a" | "looped";
  selected: boolean;
  onSelect: () => void;
}) {
  const p = phaseOf(card.stage);
  const rogue = card.agent === "rogue";
  return (
    // staggered entrance → the agents "appear" as they're discovered
    <div className="reveal flex w-44 flex-col items-center" style={{ animationDelay: `${index * 110}ms` }}>
      {/* A2A edge chip */}
      <div className="mono w-full truncate rounded-md border border-conduit-border/60 px-2 py-1 text-center text-[9.5px] text-conduit-muted">
        {rogue ? "↯ hijacked" : mode === "a2a" ? `← scoped · ≤${card.priceUsdc}` : `← ≤${card.priceUsdc}`}
      </div>
      <span className="text-conduit-muted/30">▼</span>

      {/* specialist node */}
      <button
        onClick={onSelect}
        className={`w-full rounded-xl border px-3 py-2.5 text-left transition-all ${selected ? "ring-1" : ""}`}
        style={{ borderColor: `${p.accent}66`, background: `${p.accent}0d`, boxShadow: selected ? `0 0 0 1px ${p.accent}` : undefined }}
      >
        <div className="flex items-center gap-1.5">
          <span className={`h-2 w-2 rounded-full ${p.working ? "animate-pulse" : ""}`} style={{ background: p.accent, boxShadow: `0 0 8px ${p.accent}` }} />
          <span className="mono text-[11px] font-semibold" style={{ color: rogue ? MAGENTA : "#fff" }}>
            {rogue ? card.label : `◇ ${card.agent}`}
          </span>
        </div>
        {!rogue && <p className="mono mt-0.5 truncate text-[10px] text-conduit-muted">pays {card.label}</p>}
        <p className="mono mt-0.5 text-[10px] text-conduit-muted/70">{short(card.agentAddress) !== "—" ? short(card.agentAddress) : (rogue ? "→ 0xRogue" : "")}</p>
        <p className="mono mt-1 text-[10px] underline-offset-2 hover:underline" style={{ color: p.accent }}>inspect ⌄</p>
      </button>

      {/* node → gate: a glowing payment dot travels down while in flight */}
      <div
        className={`my-0.5 h-6 w-px ${p.working ? "flow-rail" : ""}`}
        style={{ background: p.working ? `${p.accent}55` : "rgba(255,255,255,0.08)" }}
      />

      {/* gate cell — glows as the payment passes through */}
      <div
        className={`w-full rounded-md border px-2 py-1 text-center ${p.working ? "gate-active" : ""}`}
        style={{ borderColor: `${p.accent}55` }}
      >
        <span className="mono text-[10px]" style={{ color: p.accent }}>{p.gate}</span>
      </div>
      <span className="text-conduit-muted/30">▼</span>

      {/* service result */}
      <div className="w-full text-center">
        <span className="mono text-[10px]" style={{ color: p.done ? CYAN : p.blocked ? MAGENTA : "#5b6472" }}>
          {p.service}
        </span>
        {card.txHash && card.txHash.startsWith("0x") && (
          <a
            href={`${config.explorerUrl}/tx/${card.txHash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="mono block text-[9.5px] text-conduit-cyan underline-offset-2 hover:underline"
          >
            tx {short(card.txHash)} ↗
          </a>
        )}
        {card.reason && <p className="mono mt-0.5 text-[9px] leading-tight text-conduit-magenta/80">{card.reason}</p>}
      </div>
    </div>
  );
}

function Node({ kind, label, sub, accent, idle, }: { kind: string; label: string; sub: string; accent: string; idle?: boolean }) {
  return (
    <div className={`rounded-xl border px-4 py-2.5 text-center ${idle ? "opacity-60" : ""}`} style={{ borderColor: `${accent}66`, background: `${accent}0d` }} data-kind={kind}>
      <div className="mono text-[12px] font-semibold text-white">{label}</div>
      <div className="mono text-[10px] text-conduit-muted">{sub}</div>
    </div>
  );
}

function Connector() {
  return <div className="my-1 h-5 w-px bg-conduit-border" />;
}

function EdgeLabel({ text }: { text: string }) {
  return <span className="mono mt-1 rounded border border-conduit-border/50 px-1.5 py-0.5 text-[9.5px] text-conduit-muted">{text}</span>;
}

function Line({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-start justify-between gap-3 py-0.5">
      <span className="shrink-0 text-conduit-muted/60">{k}</span>
      <span className="text-right text-white">{v}</span>
    </div>
  );
}

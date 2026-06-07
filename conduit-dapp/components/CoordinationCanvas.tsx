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
import type { RogueAttack, RogueKind } from "@/lib/coordinator";

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
  /** Where the purchased output came from (e.g. "venice:crypto-rpc · …"). */
  source?: string;
  /** Rogue attempt kind (drives the attack inspector template). */
  rogueKind?: RogueKind;
  /** The x402 attack vector (field-level) shown in the intruder lane. */
  attack?: RogueAttack;
  /** Rejected by the budget cap (a limit reached), not an attack — render amber. */
  budgetCapped?: boolean;
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
const AMBER = "#F5A623"; // budget cap reached (a limit, not an attack)

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

/** A discovered marketplace agent (from the ERC-8004 registry / catalog). */
export interface MarketAgent {
  id: string;
  name: string;
  role: string;
  veniceEndpoint: string;
  priceUsdc: string;
  agentId?: string;
  source: "registry" | "catalog";
}

export function CoordinationCanvas({
  userAddress,
  coordinatorAddress,
  cards,
  market = [],
  mode,
  budget,
  revoked = false,
}: {
  userAddress?: string | null;
  coordinatorAddress?: string | null;
  cards: CanvasCard[];
  market?: MarketAgent[];
  mode: "a2a" | "looped";
  budget: Budget;
  revoked?: boolean;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const selectedCard = cards.find((c) => c.correlationId === selected) ?? null;
  const dim = revoked ? "opacity-30 grayscale transition-all duration-700" : "transition-all duration-500";
  // The rogue is an EXTERNAL attacker — keep it out of your authorized tree.
  const legit = cards.filter((c) => c.agent !== "rogue");
  const rogues = cards.filter((c) => c.agent === "rogue");
  // Which discovered agents got hired (by service id) — for the marketplace row.
  const hiredIds = new Set(legit.map((c) => c.service));
  const veniceFor = (serviceId: string) => market.find((m) => m.id === serviceId)?.veniceEndpoint;
  const planned = hiredIds.size > 0; // the coordinator has chosen → highlight/dim
  const avatar = (id: string) => `https://api.dicebear.com/9.x/bottts/svg?seed=${encodeURIComponent(id)}`;
  const REGISTRY_BY_CHAIN: Record<number, string> = {
    84532: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    8453: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
  };
  const registry = REGISTRY_BY_CHAIN[config.chainId];

  if (cards.length === 0) {
    return (
      <div className="flex min-h-[460px] flex-col items-center justify-center text-center">
        <Node kind="you" label="YOU" sub={`one permission · up to ${budget.capUsdc} USDC`} accent={CYAN} />
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
        <EdgeLabel text={`grant up to ${budget.capUsdc} USDC / period`} />
        <Connector />
        {/* COORDINATOR */}
        <Node kind="coordinator" label="◆ COORDINATOR" sub={short(coordinatorAddress)} accent={VIOLET} />
        <p className="mt-2 text-[10px] uppercase tracking-wide text-conduit-muted/70">
          {legit.length > 0
            ? `hires ${legit.length} specialist${legit.length === 1 ? "" : "s"} · ${mode === "a2a" ? "A2A sub-agents" : "direct"}`
            : "no tasks yet"}
        </p>
        <Connector />
      </div>

      {/* DISCOVERY — the marketplace found on ERC-8004, as rich agent cards.
          They appear staggered (discovery), then the chosen glow + the rest dim
          (selection) once the coordinator plans. */}
      {market.length > 0 && (
        <div className={`mx-auto mb-4 max-w-5xl ${dim}`}>
          <div className="mb-2 flex items-center justify-center gap-2 text-[10px] uppercase tracking-wide">
            <span className="h-px w-8 bg-conduit-border/60" />
            <span className="text-conduit-muted/70">
              Discovered on ERC-8004 · {market.length} agents
              {market.some((m) => m.source === "registry") ? " · on-chain" : ""}
            </span>
            <span className="mono rounded bg-conduit-cyan/10 px-1.5 py-0.5 text-[9px] normal-case text-conduit-cyan">x402</span>
            <span className="mono rounded bg-conduit-violet/15 px-1.5 py-0.5 text-[9px] normal-case text-conduit-violet">ERC-7710</span>
            <span className="h-px w-8 bg-conduit-border/60" />
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {market.map((m, i) => {
              const hired = hiredIds.has(m.id);
              const unit = m.role === "feed" ? "/period" : "/req";
              return (
                <div
                  key={m.id}
                  className="reveal rounded-xl border p-2.5 text-center transition-all duration-500"
                  style={{
                    animationDelay: `${i * 70}ms`,
                    borderColor: hired ? `${CYAN}88` : "rgba(255,255,255,0.10)",
                    background: hired ? `${CYAN}12` : "transparent",
                    boxShadow: hired ? `0 0 16px -3px ${CYAN}66` : undefined,
                    opacity: planned && !hired ? 0.4 : 1,
                  }}
                >
                  <div className="relative mx-auto h-12 w-12">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={avatar(m.id)} alt={m.name} className="h-12 w-12 rounded-lg bg-black/30" />
                    {hired && (
                      <span className="mono absolute -right-1 -top-1 rounded-full bg-conduit-cyan px-1 text-[8px] font-bold text-black">✓</span>
                    )}
                  </div>
                  <p className="mono mt-1.5 truncate text-[11px] font-semibold text-white">{m.name}</p>
                  <p className="mono truncate text-[9px] text-conduit-violet/90">{m.veniceEndpoint.replace(/^venice:/, "✦ ")}</p>
                  <p className="mono mt-1 text-[12px] font-semibold text-white">
                    ${m.priceUsdc}
                    <span className="ml-0.5 text-[9px] font-normal text-conduit-muted">USDC{unit}</span>
                  </p>
                  <div className="mt-1.5 flex justify-center gap-1">
                    <span className="mono rounded bg-conduit-cyan/10 px-1 py-0.5 text-[8px] text-conduit-cyan">x402</span>
                    <span className="mono rounded bg-conduit-violet/15 px-1 py-0.5 text-[8px] text-conduit-violet">erc7710</span>
                  </div>
                  {m.agentId && registry ? (
                    <a
                      href={`${config.explorerUrl}/nft/${registry}/${m.agentId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mono mt-1 block text-[9px] text-conduit-cyan/90 underline-offset-2 hover:underline"
                    >
                      agent #{m.agentId} ↗
                    </a>
                  ) : (
                    <span className="mono mt-1 block text-[9px] text-conduit-muted/50">catalog</span>
                  )}
                </div>
              );
            })}
          </div>

          <p className="mt-3 text-center text-[10px] text-conduit-muted/70">
            {planned
              ? `Coordinator hired ${hiredIds.size} — the best agent for each role ↓`
              : "Coordinator is selecting the best agent for each role…"}
          </p>
        </div>
      )}

      {/* SPECIALISTS row — only the agents YOU authorized (rogue is external) */}
      <div className={`flex flex-wrap items-stretch justify-center gap-3 ${dim}`}>
        {legit.map((c, i) => (
          <SpecialistColumn
            key={c.correlationId}
            card={c}
            index={i}
            mode={mode}
            venice={veniceFor(c.service)}
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

      {/* INTRUDER LANE — the rogue is an EXTERNAL attacker hitting the SAME
          Conduit gate and getting bounced. Spatially separated from your tree. */}
      {rogues.length > 0 && (
        <div className="mx-auto mt-5 max-w-3xl">
          <div className="mb-2 flex items-center gap-2">
            <span className="h-px flex-1" style={{ background: `${MAGENTA}33` }} />
            <span className="mono text-[10px] uppercase tracking-wide" style={{ color: MAGENTA }}>
              ⚠ external · not one of your authorized agents
            </span>
            <span className="h-px flex-1" style={{ background: `${MAGENTA}33` }} />
          </div>
          <div className="flex flex-col gap-3">
            {rogues.map((c) => (
              <IntruderCard key={c.correlationId} card={c} />
            ))}
          </div>
        </div>
      )}

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
              <Line k="budget cap" v={`up to ${selectedCard.priceUsdc} USDC · intent-bound`} />
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
  venice,
  selected,
  onSelect,
}: {
  card: CanvasCard;
  index: number;
  mode: "a2a" | "looped";
  venice?: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const p = phaseOf(card.stage);
  return (
    // staggered entrance → the agents "appear" as they're discovered
    <div className="reveal flex w-44 flex-col items-center" style={{ animationDelay: `${index * 110}ms` }}>
      {/* A2A edge chip */}
      <div className="mono w-full truncate rounded-md border border-conduit-border/60 px-2 py-1 text-center text-[9.5px] text-conduit-muted">
        {mode === "a2a" ? `← scoped · up to ${card.priceUsdc}` : `← up to ${card.priceUsdc}`}
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
          <span className="mono truncate text-[11px] font-semibold text-white">
            ◇ {card.label}
          </span>
        </div>
        {venice && (
          <p className="mono mt-0.5 truncate text-[9.5px] text-conduit-violet/90">{venice.replace(/^venice:/, "✦ ")}</p>
        )}
        <p className="mono mt-0.5 truncate text-[10px] text-conduit-muted/70">{short(card.agentAddress) !== "—" ? short(card.agentAddress) : card.agent}</p>
        <p className="mono mt-1 text-[10px] underline-offset-2 hover:underline" style={{ color: p.accent }}>inspect ⌄</p>
      </button>

      {/* node → gate: a glowing payment dot travels down while in flight */}
      <div
        className={`my-0.5 h-6 w-px ${p.working ? "flow-rail" : ""}`}
        style={{ background: p.working ? `${p.accent}55` : "rgba(255,255,255,0.08)" }}
      />

      {/* gate cell — glows as the payment passes through. Budget-cap rejections
          render amber (a limit reached), distinct from magenta attacks. */}
      <div
        className={`w-full rounded-md border px-2 py-1 text-center ${p.working ? "gate-active" : ""}`}
        style={{ borderColor: `${card.budgetCapped ? AMBER : p.accent}55` }}
      >
        <span className="mono text-[10px]" style={{ color: card.budgetCapped ? AMBER : p.accent }}>
          {card.budgetCapped ? "BUDGET CAP ✋" : p.gate}
        </span>
      </div>
      <span className="text-conduit-muted/30">▼</span>

      {/* service result */}
      <div className="w-full text-center">
        <span className="mono text-[10px]" style={{ color: card.budgetCapped ? AMBER : p.done ? CYAN : p.blocked ? MAGENTA : "#5b6472" }}>
          {card.budgetCapped ? "over budget" : p.service}
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
        {p.done && card.source?.startsWith("venice") && (
          <span className="mono mt-0.5 block text-[9px] text-conduit-violet" title={card.source}>
            ✦ via Venice
          </span>
        )}
        {card.reason && (
          <p className="mono mt-0.5 text-[9px] leading-tight" style={{ color: card.budgetCapped ? `${AMBER}cc` : undefined }}>
            <span className={card.budgetCapped ? "" : "text-conduit-magenta/80"}>{card.reason}</span>
          </p>
        )}
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

const ROGUE_ENFORCER: Record<RogueKind, string> = {
  redirect: "X402ReceiptEnforcer",
  overspend: "X402ReceiptEnforcer",
  replay: "IdEnforcer",
};

/**
 * The intruder lane: a compromised, EXTERNAL agent crafting a malicious x402
 * payment and getting bounced by the SAME Conduit gate. Shows the attack
 * vector field-by-field (the violating field struck through vs the bound
 * caveat) + the real on-chain reject reason.
 */
function IntruderCard({ card }: { card: CanvasCard }) {
  const kind = card.rogueKind ?? card.attack?.kind ?? "redirect";
  const a = card.attack;
  const blocked = card.stage === "denied";
  const breached = card.stage === "settled"; // must never happen
  const inflight = !blocked && !breached;
  const attacker = a?.attemptedPayTo ? short(a.attemptedPayTo) : "0xRogue…";

  return (
    <div className="rounded-xl border px-4 py-3" style={{ borderColor: `${MAGENTA}66`, background: `${MAGENTA}0a` }}>
      <div className="flex items-center justify-between gap-2">
        <span className="mono text-[11px] font-semibold" style={{ color: MAGENTA }}>
          ⚠ COMPROMISED AGENT · {card.label}
        </span>
        <span
          className="mono shrink-0 rounded px-1.5 py-0.5 text-[9.5px]"
          style={
            blocked
              ? { background: `${MAGENTA}22`, color: MAGENTA }
              : breached
                ? { background: `${MAGENTA}33`, color: "#fff" }
                : { border: `1px solid ${MAGENTA}44`, color: MAGENTA }
          }
        >
          {blocked ? "✗ BLOCKED on-chain" : breached ? "⚠ BREACH" : "submitting…"}
        </span>
      </div>
      <p className="mono mt-0.5 text-[10px] text-conduit-muted/70">
        {attacker} · external · {card.rationale}
      </p>

      {inflight ? (
        <p className="mono mt-2.5 text-[10.5px] text-conduit-muted">
          submitting a malicious x402 payment…
        </p>
      ) : (
        <>
          {/* x402 attack inspector — what it crafted vs the bound caveat */}
          <div className="mono mt-2.5 rounded-lg border border-conduit-border/50 bg-black/25 p-2.5 text-[10.5px]">
            <p className="mb-1.5 uppercase tracking-wide text-conduit-muted/60">x402 X-PAYMENT it crafted</p>
            {kind === "redirect" && (
              <>
                <AttackRow field="payTo" value={short(a?.attemptedPayTo)} ok={false} note={`bound ${short(a?.boundPayTo)}`} />
                <AttackRow field="amount" value="within cap" ok />
                <AttackRow field="intent" value="fresh id" ok />
              </>
            )}
            {kind === "overspend" && (
              <>
                <AttackRow field="payTo" value="bound recipient" ok />
                <AttackRow field="amount" value={`${a?.attemptedAmountUsdc ?? "5.00"} USDC`} ok={false} note={`cap ${a?.boundAmountUsdc ?? "—"} USDC`} />
                <AttackRow field="intent" value="fresh id" ok />
              </>
            )}
            {kind === "replay" && (
              <>
                <AttackRow field="intent" value="reused · already settled" ok={false} note="one-shot id" />
                <AttackRow field="payTo" value="matches original" ok />
                <AttackRow field="amount" value="matches original" ok />
              </>
            )}
          </div>

          {/* hits the SAME gate → bounced */}
          <div className="mt-2 flex flex-col items-center">
            <span className="text-conduit-muted/40">↓</span>
            <div
              className="w-full rounded-md border px-3 py-1.5 text-center"
              style={{ borderColor: blocked ? `${MAGENTA}66` : `${CYAN}44`, background: blocked ? `${MAGENTA}0d` : undefined }}
            >
              <span className="mono text-[10px]" style={{ color: blocked ? MAGENTA : CYAN }}>
                ╪ CONDUIT GATE ╪ {blocked ? "✗ BLOCKED" : ""}
              </span>
            </div>
            {blocked && (
              <p className="mono mt-1.5 text-center text-[10px]" style={{ color: MAGENTA }}>
                {ROGUE_ENFORCER[kind]} ✗ {card.reason ?? "rejected"}
              </p>
            )}
            {breached && (
              <p className="mono mt-1.5 text-center text-[10px]" style={{ color: MAGENTA }}>
                ⚠ unexpectedly settled — investigate the caveats
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function AttackRow({ field, value, ok, note }: { field: string; value?: string; ok: boolean; note?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-0.5">
      <span className="shrink-0 text-conduit-muted/60">{field}</span>
      <span className="flex items-center gap-1.5 text-right">
        <span style={ok ? { color: "#fff" } : { color: MAGENTA, textDecoration: "line-through" }}>{value ?? "—"}</span>
        {note && <span className="text-conduit-muted/50">({note})</span>}
        <span style={{ color: ok ? CYAN : MAGENTA }}>{ok ? "✓" : "✗"}</span>
      </span>
    </div>
  );
}

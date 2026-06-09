import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { Response } from "express";

/**
 * The facilitator's live event stream — the spine of Conduit's operations
 * console. Every x402 payment that flows through the facilitator emits a
 * sequence of stage events that the dapp subscribes to over SSE:
 *
 *   request    — an x402 payment arrived for verification (service, cost, agent)
 *   permission — the erc7710 caveat check result (ALLOWED / DENIED + reason)
 *   settle     — the redemption was submitted to the relay (tx hash)
 *   settled    — the tx confirmed or failed on-chain
 *
 * The authoritative fields (allowed, reason, txHash, status) come from the
 * facilitator's own verify/settle logic. The descriptive labels (service,
 * agent, resource) ride in via the request's optional `meta` block — they
 * annotate WHO is paying for WHAT, the way a real payments dashboard shows.
 */

export type EventStage = "request" | "permission" | "settle" | "settled";

/** Descriptive labels a caller may attach to a payment for the console feed. */
export interface EventMeta {
  service?: string; // e.g. "venice-image"
  agent?: string; // e.g. "execute"
  resource?: string; // the x402 resource URL
  amount?: string; // token base units (string)
}

export interface ConduitEvent extends EventMeta {
  id: string;
  ts: number;
  stage: EventStage;
  /** Correlates the events of one payment (the x402 intent hash if provided). */
  correlationId?: string;
  jobId?: string;
  // permission stage
  allowed?: boolean;
  reason?: string | null;
  // settle / settled stages
  status?: string;
  txHash?: string | null;
  /** For a "settled" confirmation: how we learned of it — 1Shot's signed
   *  webhook (the bonus path) or our polling fallback. */
  via?: "webhook" | "poll";
}

const bus = new EventEmitter();
bus.setMaxListeners(0); // many SSE subscribers
const recent: ConduitEvent[] = [];
const MAX_RECENT = 100;

/** Emit one event onto the bus + keep it in the recent ring buffer. */
export function emitEvent(e: Omit<ConduitEvent, "id" | "ts">): ConduitEvent {
  const full: ConduitEvent = { ...e, id: randomUUID(), ts: Date.now() };
  recent.push(full);
  if (recent.length > MAX_RECENT) recent.shift();
  bus.emit("event", full);
  return full;
}

export function recentEvents(): ConduitEvent[] {
  return [...recent];
}

/**
 * Attach an Express response as an SSE subscriber. Streams every subsequent
 * event; returns an unsubscribe fn the caller wires to the request's "close".
 */
export function subscribe(res: Response): () => void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // disable proxy buffering
  res.flushHeaders?.();
  res.write(`retry: 3000\n\n`); // tell EventSource to retry after 3s if dropped

  const onEvent = (e: ConduitEvent) => {
    res.write(`data: ${JSON.stringify(e)}\n\n`);
  };
  bus.on("event", onEvent);

  // Heartbeat so intermediaries don't time the connection out.
  const heartbeat = setInterval(() => res.write(`: ping\n\n`), 25_000);

  return () => {
    clearInterval(heartbeat);
    bus.off("event", onEvent);
  };
}

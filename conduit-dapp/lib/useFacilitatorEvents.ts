"use client";
/**
 * Subscribes to the facilitator's live SSE event stream (GET /events) — the
 * feed that powers the Conduit operations console. Returns the rolling list of
 * events plus the connection state.
 */
import { useEffect, useRef, useState } from "react";
import { config } from "./config";

export type EventStage = "request" | "permission" | "settle" | "settled";

export interface ConduitEvent {
  id: string;
  ts: number;
  stage: EventStage;
  correlationId?: string;
  jobId?: string;
  service?: string;
  agent?: string;
  resource?: string;
  amount?: string;
  allowed?: boolean;
  reason?: string | null;
  status?: string;
  txHash?: string | null;
}

export function useFacilitatorEvents(enabled = true) {
  const [events, setEvents] = useState<ConduitEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const es = new EventSource(`${config.facilitatorUrl}/events`);
    esRef.current = es;
    es.onopen = () => {
      setConnected(true);
      // The /events stream is live-only. On (re)connect, backfill the ring
      // buffer so confirmations emitted during a gap aren't lost. Consumers
      // dedupe by event id, so re-delivering already-seen events is harmless.
      fetch(`${config.facilitatorUrl}/events/recent`)
        .then((r) => (r.ok ? r.json() : { events: [] }))
        .then((d) => {
          const recent = (d.events ?? []) as ConduitEvent[];
          if (recent.length) setEvents((list) => [...list, ...recent]);
        })
        .catch(() => {});
    };
    es.onerror = () => setConnected(false);
    es.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data) as ConduitEvent;
        setEvents((list) => [...list, ev]);
      } catch {
        // ignore heartbeats / malformed frames
      }
    };
    return () => {
      es.close();
      esRef.current = null;
      setConnected(false);
    };
  }, [enabled]);

  const clear = () => setEvents([]);
  return { events, connected, clear };
}

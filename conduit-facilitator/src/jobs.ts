import { randomUUID } from "node:crypto";
import type { Hex } from "viem";
import type { RelayStatus } from "./relayers/types.js";

/**
 * In-memory job store. A settle request returns a job id immediately; the
 * relay backend updates the job as the tx progresses. Callers either poll
 * GET /jobs/:id or receive a webhook (see webhook.ts).
 *
 * In-memory is fine for a hackathon / single-instance deploy. A production
 * multi-instance deploy would back this with Redis or a DB.
 */

export interface Job {
  id: string;
  status: RelayStatus;
  txHash?: Hex;
  error?: string;
  /** How the job reached "confirmed": 1Shot's signed webhook (the bonus path)
   *  or our getStatus polling fallback. Surfaced so the UI can show it. */
  confirmedVia?: "webhook" | "poll";
  createdAt: number;
  updatedAt: number;
}

const jobs = new Map<string, Job>();
// Maps a relayer TaskId → our jobId, so inbound 1Shot webhooks (which reference
// the task by its TaskId) can resolve the job they belong to.
const taskToJob = new Map<string, string>();

export function linkTask(taskId: string, jobId: string): void {
  taskToJob.set(taskId.toLowerCase(), jobId);
}

export function getJobByTask(taskId: string): Job | undefined {
  const id = taskToJob.get(taskId.toLowerCase());
  return id ? jobs.get(id) : undefined;
}

export function createJob(): Job {
  const now = Date.now();
  const job: Job = {
    id: randomUUID(),
    status: "submitted",
    createdAt: now,
    updatedAt: now,
  };
  jobs.set(job.id, job);
  return job;
}

const settledWaiters = new Map<string, ((job: Job) => void)[]>();

// A single hook fired once when any job reaches a terminal state, regardless of
// relay path (oneshot poll or inbound 1Shot webhook).
// Registered by index.ts to forward a clean status event to the integrator's
// WEBHOOK_URL — so devs building on Conduit get push notifications without
// touching the relayer/chain. Set via a registrar to avoid a jobs↔webhook cycle.
let onTerminal: ((job: Job) => void) | null = null;
const firedTerminal = new Set<string>();

export function setTerminalHook(fn: (job: Job) => void): void {
  onTerminal = fn;
}

/** Resolve when a job reaches a terminal state (confirmed | failed). */
export function onJobSettled(id: string, cb: (job: Job) => void): void {
  const job = jobs.get(id);
  if (job && (job.status === "confirmed" || job.status === "failed")) {
    cb(job);
    return;
  }
  const list = settledWaiters.get(id) ?? [];
  list.push(cb);
  settledWaiters.set(id, list);
}

export function updateJob(
  id: string,
  patch: Partial<Pick<Job, "status" | "txHash" | "error" | "confirmedVia">>
): Job | undefined {
  const job = jobs.get(id);
  if (!job) return undefined;
  Object.assign(job, patch, { updatedAt: Date.now() });
  if (job.status === "confirmed" || job.status === "failed") {
    const waiters = settledWaiters.get(id);
    if (waiters) {
      settledWaiters.delete(id);
      for (const cb of waiters) cb(job);
    }
    // Forward to the integrator's webhook exactly once per job.
    if (onTerminal && !firedTerminal.has(id)) {
      firedTerminal.add(id);
      onTerminal(job);
    }
  }
  return job;
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

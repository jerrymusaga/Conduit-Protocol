import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Hex } from "viem";
import { config } from "./config.js";
import type { RelayStatus } from "./relayers/types.js";

/**
 * Job store. A settle request returns a job id immediately; the relay backend
 * updates the job as the tx progresses. Callers either poll GET /jobs/:id or
 * receive a webhook (see relayerWebhook.ts).
 *
 * Persisted to a JSON file (JOBS_FILE) so a restart MID-SETTLEMENT doesn't
 * orphan a job: inbound 1Shot webhooks (keyed by TaskId) can still resolve the
 * job, and `pendingTasks()` lets the relay backend resume polling on boot.
 * Pruned by TTL so the file stays bounded. Single-instance / hackathon scale; a
 * production multi-instance deploy would back this with Redis or a DB.
 */

const JOBS_FILE = config.jobsFile;
// Keep terminal jobs around briefly (so a late webhook/poll still finds them),
// then prune so the store stays bounded.
const TERMINAL_TTL_MS = 24 * 60 * 60_000; // 24h
// Hard cap on non-terminal age — a job stuck pending past this is abandoned and
// pruned (the relayer's own task has long since resolved or failed).
const STALE_PENDING_TTL_MS = 6 * 60 * 60_000; // 6h

export interface Job {
  id: string;
  status: RelayStatus;
  txHash?: Hex;
  error?: string;
  /** How the job reached "confirmed": 1Shot's signed webhook (the bonus path)
   *  or our getStatus polling fallback. Surfaced so the UI can show it. */
  confirmedVia?: "webhook" | "poll";
  /** The relayer TaskId this job was submitted as (set via linkTask). Persisted
   *  so polling can resume after a restart. */
  taskId?: string;
  createdAt: number;
  updatedAt: number;
}

const jobs = new Map<string, Job>();
// Maps a relayer TaskId → our jobId, so inbound 1Shot webhooks (which reference
// the task by its TaskId) can resolve the job they belong to.
const taskToJob = new Map<string, string>();

const isTerminal = (s: RelayStatus): boolean => s === "confirmed" || s === "failed";

// --- persistence -----------------------------------------------------------

function prune(): void {
  const cutTerminal = Date.now() - TERMINAL_TTL_MS;
  const cutPending = Date.now() - STALE_PENDING_TTL_MS;
  for (const [id, job] of jobs) {
    const dead = isTerminal(job.status)
      ? job.updatedAt < cutTerminal
      : job.createdAt < cutPending;
    if (dead) {
      jobs.delete(id);
      if (job.taskId) taskToJob.delete(job.taskId.toLowerCase());
    }
  }
}

function load(): void {
  try {
    if (!existsSync(JOBS_FILE)) return;
    const raw = readFileSync(JOBS_FILE, "utf8").trim();
    if (!raw) return;
    const list = JSON.parse(raw) as Job[];
    for (const job of list) {
      jobs.set(job.id, job);
      if (job.taskId) taskToJob.set(job.taskId.toLowerCase(), job.id);
    }
    prune();
    console.log(`[jobs] loaded ${jobs.size} job(s) from ${JOBS_FILE}`);
  } catch (err) {
    console.warn(`[jobs] could not load ${JOBS_FILE}:`, err instanceof Error ? err.message : err);
  }
}

let persistQueued = false;
/** Debounced atomic write — coalesces bursts of updates into one flush. */
function persist(): void {
  if (persistQueued) return;
  persistQueued = true;
  setTimeout(() => {
    persistQueued = false;
    try {
      mkdirSync(dirname(JOBS_FILE), { recursive: true });
      const tmp = `${JOBS_FILE}.tmp`;
      writeFileSync(tmp, JSON.stringify([...jobs.values()], null, 2), "utf8");
      renameSync(tmp, JOBS_FILE);
    } catch (err) {
      console.warn(`[jobs] could not persist ${JOBS_FILE}:`, err instanceof Error ? err.message : err);
    }
  }, 250).unref?.();
}

load();

export function linkTask(taskId: string, jobId: string): void {
  taskToJob.set(taskId.toLowerCase(), jobId);
  const job = jobs.get(jobId);
  if (job) {
    job.taskId = taskId;
    persist(); // durable: an inbound webhook can resolve this after a restart
  }
}

export function getJobByTask(taskId: string): Job | undefined {
  const id = taskToJob.get(taskId.toLowerCase());
  return id ? jobs.get(id) : undefined;
}

/** Non-terminal jobs that have a linked TaskId — used on boot to resume polling
 *  so a restart mid-settlement still drives the job to a terminal state. */
export function pendingTasks(): { taskId: string; jobId: string }[] {
  const out: { taskId: string; jobId: string }[] = [];
  for (const job of jobs.values()) {
    if (!isTerminal(job.status) && job.taskId) out.push({ taskId: job.taskId, jobId: job.id });
  }
  return out;
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
  persist();
  return job;
}

const settledWaiters = new Map<string, ((job: Job) => void)[]>();

// A single hook fired once when any job reaches a terminal state, regardless of
// relay path (oneshot poll or inbound 1Shot webhook).
// Registered by index.ts to forward a clean status event to the integrator's
// WEBHOOK_URL — so devs building on Conduit get push notifications without
// touching the relayer/chain. Set via a registrar to avoid a jobs↔webhook cycle.
let onTerminal: ((job: Job) => void) | null = null;
// id → the terminal status we last notified for. Lets us RE-fire when a job is
// corrected (e.g. a poll-timeout "failed" that a late webhook flips to
// "confirmed"), so the integrator isn't left with a wrong terminal status.
const firedTerminal = new Map<string, RelayStatus>();

export function setTerminalHook(fn: (job: Job) => void): void {
  onTerminal = fn;
}

/** Resolve when a job reaches a terminal state (confirmed | failed). */
export function onJobSettled(id: string, cb: (job: Job) => void): void {
  const job = jobs.get(id);
  if (job && isTerminal(job.status)) {
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
  if (isTerminal(job.status)) {
    persist(); // durable: terminal state survives a restart (no re-settle/re-notify)
    const waiters = settledWaiters.get(id);
    if (waiters) {
      settledWaiters.delete(id);
      for (const cb of waiters) cb(job);
    }
    // Forward to the integrator's webhook once per terminal status — and again
    // only if the status was CORRECTED (failed → confirmed), so a premature
    // failure that later confirms doesn't leave the integrator misinformed.
    if (onTerminal && firedTerminal.get(id) !== job.status) {
      firedTerminal.set(id, job.status);
      onTerminal(job);
    }
  }
  return job;
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

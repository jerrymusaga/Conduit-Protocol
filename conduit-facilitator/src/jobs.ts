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
  patch: Partial<Pick<Job, "status" | "txHash" | "error">>
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
  }
  return job;
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

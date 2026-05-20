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

export function updateJob(
  id: string,
  patch: Partial<Pick<Job, "status" | "txHash" | "error">>
): Job | undefined {
  const job = jobs.get(id);
  if (!job) return undefined;
  Object.assign(job, patch, { updatedAt: Date.now() });
  return job;
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

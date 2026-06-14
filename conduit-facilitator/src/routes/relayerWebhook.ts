import { Router, type Request, type Response } from "express";
import { config } from "../config.js";
import { getJobByTask, updateJob } from "../jobs.js";
import { emitEvent } from "../events.js";
import {
  jwksUrlFor,
  verifyWebhook,
  type WebhookEvent,
} from "../relayers/oneshotWebhook.js";
import { relayerUrlForChain } from "../relayers/oneshotClient.js";

/**
 * POST /relayer-webhook — inbound 1Shot relayer status events.
 *
 * 1Shot POSTs Ed25519-signed JSON on each status change for tasks we submitted
 * with a destinationUrl. We verify the signature against 1Shot's JWKS, then use
 * the event as the source of truth for settlement status (the bonus-scored
 * path), driving the job + the live console event stream. Polling stays as the
 * fallback when no public webhook URL is configured.
 */
const jwksUrl = jwksUrlFor(
  config.oneshot.relayerUrl ?? relayerUrlForChain(config.chainId)
);

// Dedupe at-least-once delivery on (transactionId, eventName). Bounded FIFO so
// the set can't grow unbounded on a long-running instance; the job-status writes
// it guards are idempotent, so eviction of an old key is harmless. (Durable
// dedupe across restarts is unnecessary now that jobs persist + status writes
// are idempotent.)
const seen = new Set<string>();
const SEEN_MAX = 5000;
function markSeen(key: string): boolean {
  if (seen.has(key)) return false;
  seen.add(key);
  if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value as string); // evict oldest
  return true;
}

export const relayerWebhookRouter = Router();

relayerWebhookRouter.post("/relayer-webhook", async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const rawBody = (req as Request & { rawBody?: string }).rawBody;

  const ok = await verifyWebhook(body, jwksUrl, rawBody).catch(() => false);
  if (!ok) {
    console.warn(`[relayer-webhook] signature verification failed · keyId=${String(body.keyId ?? "—")}`);
    return res.status(401).json({ error: "invalid signature" });
  }

  const event = body as unknown as WebhookEvent;
  const data = (event.data ?? {}) as Record<string, unknown>;
  const taskId = String(data.transactionId ?? "");
  const dedupeKey = `${taskId}:${event.eventName}`;

  // Respond 200 fast; do the (idempotent, in-memory) work inline since it's cheap.
  if (taskId && markSeen(dedupeKey)) {
    const job = getJobByTask(taskId);
    if (job) {
      const txHash =
        (data.transactionHash as `0x${string}` | undefined) ??
        ((data.transactionReceipt as { transactionHash?: `0x${string}` } | undefined)
          ?.transactionHash);

      if (event.eventName === "TransactionExecutionSubmitted") {
        updateJob(job.id, { status: "pending", ...(txHash ? { txHash } : {}) });
      } else if (event.eventName === "TransactionExecutionSuccess") {
        updateJob(job.id, { status: "confirmed", confirmedVia: "webhook", ...(txHash ? { txHash } : {}) });
        emitEvent({ stage: "settled", jobId: job.id, status: "confirmed", txHash: txHash ?? null, via: "webhook" });
      } else if (event.eventName === "TransactionExecutionFailure") {
        const reason = (data.error as string) ?? (data.revertData as string) ?? "failed";
        updateJob(job.id, { status: "failed", error: reason });
        emitEvent({ stage: "settled", jobId: job.id, status: "failed", reason });
      }
      console.log(`[relayer-webhook] ${event.eventName} · task ${taskId.slice(0, 12)}… → job ${job.id.slice(0, 8)}`);
    }
  }

  res.status(200).json({ ok: true });
});

import type { Job } from "./jobs.js";
import { config } from "./config.js";

/**
 * Fire-and-forget status callback. When config.webhookUrl is set, every
 * job status transition is POSTed to it. The protected endpoint (or any
 * caller) can use this as the source of truth for settlement status —
 * which the 1Shot prize criteria explicitly reward.
 *
 * On testnet (viem-direct) we call this ourselves after the tx lands so
 * the consumer sees identical behavior to the mainnet (oneshot-pl) flow,
 * where 1Shot's own webhooks drive it.
 */
export async function fireWebhook(job: Job): Promise<void> {
  if (!config.webhookUrl) return;
  try {
    await fetch(config.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "conduit.settlement",
        // A clean, relayer-agnostic settlement event. The dev gets this whether
        // Conduit settled via viem-direct or by consuming 1Shot's signed webhooks
        // — they never touch the relayer, the chain, or signature verification.
        jobId: job.id,
        status: job.status, // "confirmed" | "failed"
        success: job.status === "confirmed",
        txHash: job.txHash ?? null,
        error: job.error ?? null,
        updatedAt: job.updatedAt,
      }),
    });
  } catch (err) {
    // Webhook delivery is best-effort. Polling GET /jobs/:id is the
    // fallback source of truth, so a failed callback is non-fatal.
    console.warn(
      `webhook delivery failed for job ${job.id}:`,
      err instanceof Error ? err.message : err
    );
  }
}

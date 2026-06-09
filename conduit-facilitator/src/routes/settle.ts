import { Router, type Request, type Response } from "express";
import { getJob, onJobSettled } from "../jobs.js";
import type { RelayBackend } from "../relayers/index.js";
import { facilitatorRequestSchema, toRelayParams } from "../x402.js";
import { emitEvent, recentEvents, subscribe } from "../events.js";

/**
 * POST /settle  — submit the redemption through the active relay backend.
 * GET  /jobs/:id — poll a settlement's status.
 *
 * Settlement is async: /settle returns a job id (and the tx hash once the
 * relay backend has one). The job advances to confirmed/failed in the
 * background, and — if WEBHOOK_URL is set — fires a callback. Callers that
 * don't take webhooks poll GET /jobs/:id.
 */
export function settleRouter(backend: RelayBackend): Router {
  const router = Router();

  router.post("/settle", async (req: Request, res: Response) => {
    const parsed = facilitatorRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: "malformed request: " + parsed.error.issues[0]?.message,
      });
    }

    const relayParams = toRelayParams(parsed.data.paymentPayload);
    const meta = parsed.data.meta ?? {};
    const correlationId = meta.correlationId;
    const result = await backend.submit(relayParams);

    // Stage 3: the redemption was submitted to the relay (tx hash, if any).
    emitEvent({
      stage: "settle",
      correlationId,
      service: meta.service,
      agent: meta.agent,
      jobId: result.jobId,
      status: result.status,
      txHash: result.txHash ?? null,
    });

    // Stage 4: emit when the tx reaches a terminal state (confirmed | failed).
    if (result.jobId && result.status !== "failed") {
      onJobSettled(result.jobId, (job) => {
        emitEvent({
          stage: "settled",
          correlationId,
          service: meta.service,
          agent: meta.agent,
          jobId: job.id,
          status: job.status,
          txHash: job.txHash ?? null,
          reason: job.error ?? null,
        });
      });
    } else if (result.status === "failed") {
      emitEvent({
        stage: "settled",
        correlationId,
        service: meta.service,
        agent: meta.agent,
        jobId: result.jobId,
        status: "failed",
        reason: result.error ?? null,
      });
    }

    const httpStatus = result.status === "failed" ? 502 : 202;
    res.status(httpStatus).json({
      success: result.status !== "failed",
      jobId: result.jobId,
      status: result.status,
      transaction: result.txHash ?? null,
      relayBackend: backend.name,
      error: result.error ?? null,
    });
  });

  // GET /events — Server-Sent Events stream of the live payment lifecycle.
  // The operations console subscribes here.
  router.get("/events", (req: Request, res: Response) => {
    const unsubscribe = subscribe(res);
    req.on("close", unsubscribe);
  });

  // GET /events/recent — the ring buffer, for a console that connects mid-stream.
  router.get("/events/recent", (_req: Request, res: Response) => {
    res.json({ events: recentEvents() });
  });

  router.get("/jobs/:id", (req: Request, res: Response) => {
    const job = getJob(req.params.id ?? "");
    if (!job) return res.status(404).json({ error: "job not found" });
    res.json({
      jobId: job.id,
      status: job.status,
      transaction: job.txHash ?? null,
      error: job.error ?? null,
      confirmedVia: job.confirmedVia ?? null,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    });
  });

  return router;
}

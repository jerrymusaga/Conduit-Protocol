import { Router, type Request, type Response } from "express";
import { getJob } from "../jobs.js";
import type { RelayBackend } from "../relayers/index.js";
import { facilitatorRequestSchema, toRelayParams } from "../x402.js";

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
    const result = await backend.submit(relayParams);

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

  router.get("/jobs/:id", (req: Request, res: Response) => {
    const job = getJob(req.params.id ?? "");
    if (!job) return res.status(404).json({ error: "job not found" });
    res.json({
      jobId: job.id,
      status: job.status,
      transaction: job.txHash ?? null,
      error: job.error ?? null,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    });
  });

  return router;
}

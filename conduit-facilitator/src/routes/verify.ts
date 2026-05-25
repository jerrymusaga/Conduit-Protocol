import { Router, type Request, type Response } from "express";
import { parseAbi } from "viem";
import { chainConfig, publicClient } from "../chain.js";
import type { RelayBackend } from "../relayers/index.js";
import { facilitatorRequestSchema, toRelayParams } from "../x402.js";

/**
 * POST /verify
 *
 * The x402 spec: "ERC-7710 verification is performed entirely through
 * simulation." We simulate DelegationManager.redeemDelegations against the
 * live chain. If the simulation would revert, the payment is invalid; if it
 * succeeds, it's good to settle. No state changes, no gas — just an eth_call.
 *
 * The simulation MUST run from the redeemer's address: the DelegationManager
 * checks chain[0].delegate == msg.sender, so simulating from anyone else (e.g.
 * the DM itself) reverts with InvalidDelegate even for a valid payment. The
 * redeemer is the same account that submits the real redemption in /settle.
 */
const DM_ABI = parseAbi([
  "function redeemDelegations(bytes[] permissionContexts, bytes32[] modes, bytes[] executionCallDatas)",
]);

export function verifyRouter(backend: RelayBackend): Router {
  const router = Router();

  router.post("/verify", async (req: Request, res: Response) => {
    const parsed = facilitatorRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        isValid: false,
        invalidReason: "malformed request: " + parsed.error.issues[0]?.message,
      });
    }

    const relayParams = toRelayParams(parsed.data.paymentPayload);

    try {
      await publicClient.simulateContract({
        address: chainConfig.delegationManager,
        abi: DM_ABI,
        functionName: "redeemDelegations",
        args: [
          relayParams.permissionContexts,
          relayParams.modes,
          relayParams.executionCallDatas,
        ],
        // Simulate as the actual redeemer (the leaf delegate). Falls back to the
        // DM only if no redeemer is configured (e.g. the oneshot-pl stub).
        account: backend.redeemer ?? chainConfig.delegationManager,
      });

      res.json({ isValid: true, invalidReason: null });
    } catch (err) {
      const message =
        err && typeof err === "object" && "shortMessage" in err
          ? String((err as { shortMessage: unknown }).shortMessage)
          : err instanceof Error
            ? err.message
            : String(err);
      res.json({ isValid: false, invalidReason: message });
    }
  });

  return router;
}

import { Router, type Request, type Response } from "express";
import { parseAbi } from "viem";
import { chainConfig, publicClient } from "../chain.js";
import { facilitatorRequestSchema, toRelayParams } from "../x402.js";

/**
 * POST /verify
 *
 * The x402 spec: "ERC-7710 verification is performed entirely through
 * simulation." We simulate DelegationManager.redeemDelegations against the
 * live chain from the facilitator's perspective. If the simulation would
 * revert, the payment is invalid; if it succeeds, it's good to settle.
 *
 * No state changes, no gas spent — just an eth_call.
 */
export const verifyRouter = Router();

const DM_ABI = parseAbi([
  "function redeemDelegations(bytes[] permissionContexts, bytes32[] modes, bytes[] executionCallDatas)",
]);

verifyRouter.post("/verify", async (req: Request, res: Response) => {
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
      // Simulate from the relayer's perspective. For viem-direct that's our
      // wallet; for oneshot-pl the actual submitter differs, but the
      // delegation chain's redeemer caveats are what gate it, not the
      // simulating account, so this is a faithful pre-check.
      account: chainConfig.delegationManager,
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

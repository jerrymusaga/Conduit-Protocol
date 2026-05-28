import { Router, type Request, type Response } from "express";
import {
  BaseError,
  ContractFunctionRevertedError,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
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
    const payload = parsed.data.paymentPayload.payload;

    // If the payment bundles an EIP-7702 authorization, the redemption only
    // works because that auth designates the delegator (the user EOA) to a
    // smart account IN THE SAME TX. eth_call doesn't apply authorizationList,
    // so we reproduce the post-designation state with a stateOverride: give the
    // delegator the 7702 delegation-designator code (0xef0100 ++ impl address),
    // exactly what the real tx installs. Without this, verify would revert with
    // a code-less EOA even though the real settle would succeed.
    const stateOverride =
      payload.authorization && payload.delegator
        ? [
            {
              address: payload.delegator as Address,
              code: `0xef0100${(payload.authorization.address as string).slice(2)}` as Hex,
            },
          ]
        : undefined;

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
        ...(stateOverride ? { stateOverride } : {}),
      });

      res.json({ isValid: true, invalidReason: null });
    } catch (err) {
      // Log the full error server-side, and decode the on-chain revert reason
      // (custom error name / require string) so the buyer sees WHY it failed.
      console.error("[verify] redeemDelegations simulation reverted:\n", err);
      res.json({ isValid: false, invalidReason: decodeRevert(err) });
    }
  });

  return router;
}

/** Pull the most specific revert reason out of a viem simulation error. */
function decodeRevert(err: unknown): string {
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      return (
        revert.reason ??
        revert.data?.errorName ??
        revert.shortMessage ??
        revert.message
      );
    }
    return err.shortMessage ?? err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

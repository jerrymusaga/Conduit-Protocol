import { Router, type Request, type Response } from "express";
import { chainConfig } from "../chain.js";
import { config } from "../config.js";
import type { RelayBackend } from "../relayers/index.js";

/**
 * GET /supported
 *
 * Advertises this facilitator's capabilities in the x402 V2 shape. The
 * point that matters: erc7710 is in assetTransferMethods, with the address
 * of Conduit's X402ReceiptEnforcer surfaced so clients can construct
 * redelegations carrying it — plus the `redeemer` address buyers must name
 * in their delegation's Redeemer caveat (the account that submits the
 * redemption — for oneshot-pl this is 1Shot's relayer targetAddress).
 */
export function supportedRouter(backend: RelayBackend): Router {
  const router = Router();

  router.get("/supported", async (_req: Request, res: Response) => {
    // Ensure async backend state (oneshot-pl targetAddress/feeCollector) is
    // resolved so we never advertise a null redeemer due to a warm-up race.
    try {
      await backend.ensureReady?.();
    } catch (err) {
      console.warn("[supported] backend.ensureReady failed:", err);
    }
    res.json({
      kinds: [
        {
          x402Version: 2,
          scheme: "exact",
          network: chainConfig.caip2,
          extra: {
            assetTransferMethods: ["erc7710"],
            conduit: {
              receiptEnforcer: config.receiptEnforcer,
              // X402SubscriptionEnforcer — recurring intent-bound payments.
              subscriptionEnforcer: config.subscriptionEnforcer,
              delegationManager: chainConfig.delegationManager,
              relayBackend: backend.name,
              redeemer: backend.redeemer,
              // oneshot-pl only: where the buyer pays the relayer's gas fee.
              feeCollector: backend.feeCollector ?? null,
            },
            erc7710PermissionContext:
              "permissionContext must be a 0x-prefixed hex string (ABI-encoded delegation chain). Base64 is not accepted.",
          },
        },
      ],
      extensions: [],
    });
  });

  return router;
}

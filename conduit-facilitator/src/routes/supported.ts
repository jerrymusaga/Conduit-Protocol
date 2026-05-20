import { Router, type Request, type Response } from "express";
import { chainConfig } from "../chain.js";
import { config } from "../config.js";

/**
 * GET /supported
 *
 * Advertises this facilitator's capabilities in the x402 V2 shape. The
 * point that matters: erc7710 is in assetTransferMethods, with the address
 * of Conduit's X402ReceiptEnforcer surfaced so clients can construct
 * redelegations carrying it.
 */
export const supportedRouter = Router();

supportedRouter.get("/supported", (_req: Request, res: Response) => {
  res.json({
    kinds: [
      {
        x402Version: 2,
        scheme: "exact",
        network: chainConfig.caip2,
        extra: {
          assetTransferMethods: ["erc7710"],
          // Conduit-specific: the enforcer clients should attach to a
          // redelegation to get intent-bound, single-use agent payments.
          conduit: {
            receiptEnforcer: config.receiptEnforcer,
            delegationManager: chainConfig.delegationManager,
            relayBackend: config.relayBackend,
          },
          erc7710PermissionContext:
            "permissionContext must be a 0x-prefixed hex string (ABI-encoded delegation chain). Base64 is not accepted.",
        },
      },
    ],
    extensions: [],
  });
});

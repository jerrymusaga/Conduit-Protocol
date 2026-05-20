import { config } from "./config.js";
import { chainInfo } from "./chain.js";
import type { ConduitCapabilities } from "./facilitatorClient.js";

/**
 * Builds the x402 V2 "402 Payment Required" envelope for the protected
 * resource. This is what tells the buyer how to pay: which scheme, network,
 * amount, asset, and — crucially for erc7710 — the facilitator, the
 * redeemer they must authorize, and the receipt enforcer they should bind
 * their redelegation to.
 */
export function buildPaymentRequired(
  resourceUrl: string,
  caps: ConduitCapabilities,
  error: string
) {
  return {
    x402Version: 2,
    error,
    accepts: [
      {
        scheme: "exact",
        network: chainInfo.caip2,
        maxAmountRequired: config.priceBaseUnits.toString(),
        resource: resourceUrl,
        description: config.resourceDescription,
        mimeType: "application/json",
        payTo: config.payTo,
        maxTimeoutSeconds: 60,
        asset: chainInfo.usdc,
        extra: {
          assetTransferMethod: "erc7710",
          facilitator: config.facilitatorUrl,
          // Everything the buyer's wallet needs to construct a valid,
          // intent-bound redelegation:
          delegationManager: caps.delegationManager,
          receiptEnforcer: caps.receiptEnforcer,
          // The buyer must restrict redemption to this address (Redeemer
          // caveat) — it's who actually submits the redeemDelegations tx.
          redeemer: caps.redeemer,
        },
      },
    ],
  };
}

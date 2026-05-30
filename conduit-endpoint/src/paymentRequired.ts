import { config } from "./config.js";
import { chainInfo } from "./chain.js";
import type { ConduitCapabilities } from "./facilitatorClient.js";
import type { Service } from "./services.js";

/**
 * Builds the x402 V2 "402 Payment Required" envelope for a given paid service.
 * Tells the buyer how to pay: scheme, network, the service's price, asset, and
 * — crucially for erc7710 — the facilitator, the redeemer they must authorize,
 * and the receipt enforcer to bind their redelegation to.
 */
export function buildPaymentRequired(
  resourceUrl: string,
  caps: ConduitCapabilities,
  service: Service,
  error: string
) {
  return {
    x402Version: 2,
    error,
    accepts: [
      {
        scheme: "exact",
        network: chainInfo.caip2,
        maxAmountRequired: service.priceBaseUnits.toString(),
        resource: resourceUrl,
        description: service.description,
        mimeType: "application/json",
        payTo: config.payTo,
        maxTimeoutSeconds: 60,
        asset: chainInfo.usdc,
        extra: {
          assetTransferMethod: "erc7710",
          facilitator: config.facilitatorUrl,
          // Which catalog service this 402 is for (the console label).
          service: service.id,
          serviceLabel: service.label,
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

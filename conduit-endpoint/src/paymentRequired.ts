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
          // Which enforcer binds this payment: a recurring service signals the
          // subscription enforcer + its terms (subscriptionId, period, exact
          // amount); a one-shot service uses the receipt enforcer.
          paymentKind: service.kind === "subscription" ? "subscription" : "one-shot",
          subscription:
            service.kind === "subscription" && service.subscription
              ? {
                  enforcer: caps.subscriptionEnforcer,
                  subscriptionId: service.subscription.subscriptionId,
                  periodSeconds: service.subscription.periodSeconds,
                  // For a subscription the price is the EXACT per-period charge.
                  amountPerPeriod: service.priceBaseUnits.toString(),
                  // Seller-sanctioned cadence menu the buyer may pick + sign one of.
                  ...(service.subscription.tiers
                    ? {
                        tiers: service.subscription.tiers.map((t) => ({
                          periodSeconds: t.periodSeconds,
                          amountPerPeriod: t.amountBaseUnits,
                          label: t.label,
                        })),
                      }
                    : {}),
                }
              : undefined,
          // Everything the buyer's wallet needs to construct a valid,
          // intent-bound redelegation:
          delegationManager: caps.delegationManager,
          receiptEnforcer: caps.receiptEnforcer,
          // The buyer must restrict redemption to this address (Redeemer
          // caveat) — it's who actually submits the redeemDelegations tx.
          redeemer: caps.redeemer,
          // Which relay backend is active + (oneshot-pl) the fee recipient, so
          // the buyer knows whether to build a bounded fee delegation.
          relayBackend: caps.relayBackend,
          feeCollector: caps.feeCollector ?? null,
          // Live gas-fee estimate (USDC atoms) — the buyer caps the bounded fee
          // delegation at estimate × buffer instead of a hardcoded ceiling.
          feeEstimate: caps.feeEstimate ?? null,
        },
      },
    ],
  };
}

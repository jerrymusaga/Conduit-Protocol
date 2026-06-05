import { keccak256, parseUnits, toHex } from "viem";
import { config } from "./config.js";

/**
 * The catalog of paid x402 services the demo seller offers. The prompt-driven
 * coordinator picks which of these to buy; each becomes a real priced x402
 * resource (its own 402 envelope + payment event in the Conduit console).
 *
 * `kind` tells the resource handler what to return on success:
 *   - "image": a generated image (Venice later; placeholder for now)
 *   - "text":  generated copy/text
 *   - "data":  a JSON data payload
 *   - "subscription": a RECURRING data feed — bound by X402SubscriptionEnforcer
 *      (fixed price, one merchant, at most once per period). Distinct from the
 *      one-shot kinds above, which are bound by X402ReceiptEnforcer.
 */
export type ServiceKind = "image" | "text" | "data" | "subscription";

/** Subscription-only terms a recurring service advertises in its 402 envelope. */
export interface SubscriptionTerms {
  /** Off-chain subscription identifier (bytes32), bound into the enforcer terms. */
  subscriptionId: `0x${string}`;
  /** Billing period length in seconds (the cadence / "frequency"). */
  periodSeconds: number;
}

export interface Service {
  id: string;
  /** The selling AGENT's name — these are agents that get paid through Conduit. */
  label: string;
  /** What this agent sells. */
  description: string;
  kind: ServiceKind;
  /** Human price in USDC. For a subscription this is the EXACT charge per period. */
  priceUsdc: string;
  /** Price in base units (bigint, 6-decimals). */
  priceBaseUnits: bigint;
  /** Present only when kind === "subscription". */
  subscription?: SubscriptionTerms;
}

function svc(
  id: string,
  label: string,
  kind: ServiceKind,
  priceUsdc: string,
  description: string,
  subscription?: SubscriptionTerms
): Service {
  return {
    id,
    label,
    kind,
    priceUsdc,
    priceBaseUnits: parseUnits(priceUsdc, 6),
    description,
    subscription,
  };
}

/**
 * The catalog is a set of AGENTS that sell a capability and get paid through
 * Conduit — the recipient side of agent-to-agent commerce. A coordinator agent
 * hires them; each is paid (x402+erc7710) through the facilitator, which earns
 * its fee on every hop. Prices are tiny (testnet) but distinct so the console
 * shows varied costs draining one budget.
 */
export const SERVICES: Service[] = [
  // The provider agents a procurement coordinator buys from to assemble an ETH
  // staking market report. Each is a real priced x402 + erc7710 service.
  svc("staking-data", "Data Agent", "data", "0.05",
    "Sells on-chain ETH staking metrics (TVL, staked supply, validators)."),
  svc("staking-news", "News Agent", "text", "0.03",
    "Sells a recent ETH staking news summary."),
  svc("staking-analytics", "Analytics Agent", "text", "0.07",
    "Sells ETH staking market analysis + insights."),
  // Recurring service — bound by X402SubscriptionEnforcer. Fixed price, one
  // merchant, at most once per period. The period is short (60s) so the demo
  // can show the cadence + the on-chain "already-charged-this-period" guard
  // without waiting a month. subscriptionId is deterministic from the id.
  svc("pulse-feed", "Pulse Feed Agent", "subscription", "0.01",
    "Recurring market-pulse data feed (subscription).",
    { subscriptionId: keccak256(toHex("conduit:pulse-feed")), periodSeconds: 60 }),
];

export function getService(id: string): Service | undefined {
  return SERVICES.find((s) => s.id === id);
}

/** The legacy single-resource fallback, kept so /paid-data still works. */
export const LEGACY_SERVICE: Service = svc(
  "paid-data",
  "Protected demo resource",
  "data",
  config.priceUsdc,
  config.resourceDescription
);

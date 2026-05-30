import { parseUnits } from "viem";
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
 */
export type ServiceKind = "image" | "text" | "data";

export interface Service {
  id: string;
  label: string;
  description: string;
  kind: ServiceKind;
  /** Human price in USDC. */
  priceUsdc: string;
  /** Price in base units (bigint, 6-decimals). */
  priceBaseUnits: bigint;
}

function svc(
  id: string,
  label: string,
  kind: ServiceKind,
  priceUsdc: string,
  description: string
): Service {
  return {
    id,
    label,
    kind,
    priceUsdc,
    priceBaseUnits: parseUnits(priceUsdc, 6),
    description,
  };
}

/**
 * Starter catalog. Prices are tiny (testnet) but distinct so the console shows
 * varied costs draining one budget. PRICE_USDC env still sets the default used
 * by the legacy /paid-data route.
 */
export const SERVICES: Service[] = [
  svc("venice-image", "Premium image generation", "image", "0.04",
    "Generate a high-quality image (Venice AI)."),
  svc("copywriting", "Marketing copy", "text", "0.02",
    "Generate marketing copy / taglines."),
  svc("market-data", "Market data lookup", "data", "0.01",
    "Fetch a gated market-data snapshot."),
  svc("competitor-scan", "Competitor scan", "data", "0.03",
    "Fetch a gated competitor-analysis dataset."),
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

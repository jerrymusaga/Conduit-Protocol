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
  /** The selling AGENT's name — these are agents that get paid through Conduit. */
  label: string;
  /** What this agent sells. */
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
 * The catalog is a set of AGENTS that sell a capability and get paid through
 * Conduit — the recipient side of agent-to-agent commerce. A coordinator agent
 * hires them; each is paid (x402+erc7710) through the facilitator, which earns
 * its fee on every hop. Prices are tiny (testnet) but distinct so the console
 * shows varied costs draining one budget.
 */
export const SERVICES: Service[] = [
  svc("venice-image", "ImageForge Agent", "image", "0.04",
    "Sells premium image generation (Venice AI)."),
  svc("copywriting", "Wordsmith Agent", "text", "0.02",
    "Sells marketing copy / taglines."),
  svc("market-data", "DataFeed Agent", "data", "0.01",
    "Sells a gated market-data snapshot."),
  svc("competitor-scan", "Recon Agent", "data", "0.03",
    "Sells a gated competitor-analysis dataset."),
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

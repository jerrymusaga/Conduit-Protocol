import { keccak256, parseUnits, toHex } from "viem";
import { config } from "./config.js";

/**
 * The Venice-powered agent MARKETPLACE the demo seller offers. Each service is
 * an autonomous AGENT that sells a capability powered by a Venice endpoint and
 * gets paid through Conduit (x402 + erc7710). The prompt-driven coordinator
 * discovers these on the ERC-8004 registry, picks the BEST per role, and hires
 * + pays each. Variety per role (competing providers at different price/quality)
 * makes "find the best" meaningful.
 *
 * `kind` tells the resource handler what to return on success:
 *   - "image": a generated image (Venice image)
 *   - "audio": generated speech (Venice TTS) — a playable voiceover clip
 *   - "text":  generated copy/research/analysis (Venice chat)
 *   - "data":  a JSON data payload (Venice crypto-rpc / on-chain)
 *   - "subscription": a RECURRING feed — bound by X402SubscriptionEnforcer
 *      (fixed price, one merchant, at most once per period). Distinct from the
 *      one-shot kinds above, which are bound by X402ReceiptEnforcer.
 */
export type ServiceKind = "image" | "audio" | "text" | "data" | "subscription";

/** The capability category a procurement agent fills — the coordinator picks the
 *  BEST agent per role the task needs. */
export type AgentRole =
  | "research"
  | "copy"
  | "creative" // free-form creative writing: roasts, jokes, poems, rants — does what you ask
  | "image"
  | "analysis"
  | "onchain"
  | "voice"
  | "scout" // paid market-intelligence: picks the best asset from a signed set
  | "feed"; // subscription feeds

/** One seller-offered cadence option (period + the exact price for that period). */
export interface SubscriptionTier {
  periodSeconds: number;
  /** Human price for THIS cadence. */
  priceUsdc: string;
  /** Exact per-period charge in base units (6-decimals), precomputed. */
  amountBaseUnits: string;
  /** Short label, e.g. "Weekly". */
  label: string;
}

/** Subscription-only terms a recurring service advertises in its 402 envelope. */
export interface SubscriptionTerms {
  /** Off-chain subscription identifier (bytes32), bound into the enforcer terms. */
  subscriptionId: `0x${string}`;
  /** Billing period length in seconds (the cadence / "frequency"). The default. */
  periodSeconds: number;
  /** Optional seller-sanctioned cadence menu — the buyer may pick + sign one of
   *  these instead of the default (price is fixed per tier by the seller). */
  tiers?: SubscriptionTier[];
}

export interface Service {
  id: string;
  /** The selling AGENT's name — these are agents that get paid through Conduit. */
  label: string;
  /** What this agent sells. */
  description: string;
  kind: ServiceKind;
  /** The capability category (for discovery + best-per-role selection). */
  role: AgentRole;
  /** Which Venice endpoint powers this agent (shown as a badge in the tree). */
  veniceEndpoint: string;
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
  role: AgentRole,
  veniceEndpoint: string,
  priceUsdc: string,
  description: string,
  subscription?: SubscriptionTerms
): Service {
  return {
    id,
    label,
    kind,
    role,
    veniceEndpoint,
    priceUsdc,
    priceBaseUnits: parseUnits(priceUsdc, 6),
    description,
    subscription,
  };
}

const subTerms = (
  id: string,
  periodSeconds: number,
  tiers?: { periodSeconds: number; priceUsdc: string; label: string }[]
): SubscriptionTerms => ({
  subscriptionId: keccak256(toHex(`conduit:${id}`)),
  periodSeconds,
  tiers: tiers?.map((t) => ({ ...t, amountBaseUnits: parseUnits(t.priceUsdc, 6).toString() })),
});

/**
 * The marketplace: a set of Venice-powered AGENTS that sell a capability and get
 * paid through Conduit. A coordinator hires them; each is paid (x402+erc7710)
 * through the facilitator. Prices are tiny (testnet) but distinct so the console
 * shows varied costs draining one budget — and so "best value per role" is real.
 */
export const SERVICES: Service[] = [
  // --- PROCUREMENT agents (one-shot, X402ReceiptEnforcer) -------------------
  // Competing providers per role so the coordinator's "best" pick is meaningful.
  svc("researcher", "Researcher", "text", "research", "venice:chat+search", "0.05",
    "Researches a topic with web search + synthesis."),
  svc("researcher-pro", "Premium Researcher", "text", "research", "venice:reasoning", "0.09",
    "Deep research via a Venice reasoning model — higher quality, higher price."),
  svc("copywriter", "Writer", "text", "copy", "venice:chat", "0.04",
    "Writes the brief, the announcement, the tagline — sharp marketing copy on your topic."),
  svc("roaster", "Roaster", "text", "creative", "venice:chat", "0.04",
    "Does exactly what you ask — a savage roast, a joke, a poem, a rant — in your tone."),
  svc("illustrator", "Illustrator", "image", "image", "venice:image", "0.06",
    "Generates a cover image for the deliverable (fast)."),
  svc("illustrator-pro", "Pro Illustrator", "image", "image", "venice:image-4k", "0.15",
    "High-resolution cover art — premium image model."),
  svc("analyst", "Analyst", "text", "analysis", "venice:reasoning", "0.07",
    "Analyzes the topic + gives an outlook (reasoning model)."),
  svc("onchain-scout", "Onchain Scout", "data", "onchain", "venice:crypto-rpc", "0.05",
    "Pulls real on-chain data via Venice's RPC proxy (for crypto topics)."),
  svc("narrator", "Narrator", "audio", "voice", "venice:tts", "0.07",
    "Speaks a summary of the deliverable — a playable voiceover (Venice TTS)."),

  // --- TRADING agents (one-shot, X402ReceiptEnforcer for the FEE) -----------
  // A paid market-intelligence agent. The buyer pays it (x402 + erc7710), then it
  // reasons over the buyer's APPROVED token set with live data and returns the
  // single best pick. It never sees the user's funds — it only advises; the bound
  // Trader executes the swap within the on-chain allowlist.
  svc("yield-scout", "Yield Scout", "data", "scout", "venice:chat+search", "0.06",
    "Picks the single best asset from your approved set, with live market reasoning."),

  // --- SUBSCRIPTION agents (recurring, X402SubscriptionEnforcer) ------------
  // Variety of periods for the portfolio showcase; the LIVE demo drives the 60s
  // one so the cadence + the on-chain "already-charged-this-period" guard show
  // fast. subscriptionId is deterministic from the id.
  // Each subscription offers a seller-sanctioned cadence menu (the FIRST tier is
  // the default — same as the base price/period, so existing behavior is unchanged;
  // the live demo still drives Market Pulse at 60s). The buyer may pick + sign a
  // different tier; the price is fixed per tier by the seller.
  svc("pulse-feed", "Market Pulse", "subscription", "feed", "venice:chat", "0.01",
    "A live market pulse — the single most important move right now.",
    subTerms("pulse-feed", 60, [
      { periodSeconds: 60, priceUsdc: "0.01", label: "Every minute" },
      { periodSeconds: 3_600, priceUsdc: "0.05", label: "Hourly" },
      { periodSeconds: 86_400, priceUsdc: "0.20", label: "Daily" },
    ])),
  svc("daily-digest", "AI Alpha Daily", "subscription", "feed", "venice:chat+search", "0.10",
    "Your daily AI + crypto alpha — three concrete, web-researched takeaways, every day.",
    subTerms("daily-digest", 86_400, [
      { periodSeconds: 86_400, priceUsdc: "0.10", label: "Daily" },
      { periodSeconds: 604_800, priceUsdc: "0.50", label: "Weekly" },
      { periodSeconds: 2_592_000, priceUsdc: "1.50", label: "Monthly" },
    ])),
  svc("weekly-trends", "DeFi Yield Weekly", "subscription", "feed", "venice:chat+search", "0.50",
    "A weekly DeFi yield report — where the best on-chain yields are this week (protocols + APYs).",
    subTerms("weekly-trends", 604_800, [
      { periodSeconds: 604_800, priceUsdc: "0.50", label: "Weekly" },
      { periodSeconds: 2_592_000, priceUsdc: "1.50", label: "Monthly" },
    ])),
];

export function getService(id: string): Service | undefined {
  return SERVICES.find((s) => s.id === id);
}

/** The legacy single-resource fallback, kept so /paid-data still works. */
export const LEGACY_SERVICE: Service = svc(
  "paid-data",
  "Protected demo resource",
  "data",
  "research",
  "venice:chat",
  config.priceUsdc,
  config.resourceDescription
);

/**
 * The dapp's view of the Venice agent MARKETPLACE — mirrors the seller catalog
 * on conduit-endpoint (keep ids/prices/roles in sync). Used to:
 *   - serve ERC-8004 AgentCards (app/api/agent-card/[id])
 *   - drive registration (scripts/register-agents)
 *   - render discovery + best-per-role selection in /demo and /subscription
 *
 * Each agent is a Venice-powered capability sold as an x402 + erc7710 service.
 */
import { keccak256, toHex, type Hex } from "viem";

export type AgentRole = "research" | "copy" | "image" | "analysis" | "onchain" | "voice" | "scout" | "feed";
export type PaymentKind = "one-shot" | "subscription";

export interface AgentSubscription {
  subscriptionId: Hex;
  periodSeconds: number;
}

export interface Agent {
  id: string;
  name: string;
  description: string;
  role: AgentRole;
  /** Which Venice endpoint powers this agent (badge in the tree). */
  veniceEndpoint: string;
  priceUsdc: string;
  paymentKind: PaymentKind;
  /** x402 resource path on the endpoint (joined to NEXT_PUBLIC_ENDPOINT_URL). */
  resource: string;
  /** Present only for subscription agents. */
  subscription?: AgentSubscription;
}

const sub = (id: string, periodSeconds: number): AgentSubscription => ({
  subscriptionId: keccak256(toHex(`conduit:${id}`)),
  periodSeconds,
});

function a(
  id: string,
  name: string,
  role: AgentRole,
  veniceEndpoint: string,
  priceUsdc: string,
  paymentKind: PaymentKind,
  description: string,
  subscription?: AgentSubscription
): Agent {
  return { id, name, role, veniceEndpoint, priceUsdc, paymentKind, description, resource: `/services/${id}`, subscription };
}

export const AGENTS: Agent[] = [
  // PROCUREMENT (one-shot, X402ReceiptEnforcer) — competing providers per role.
  a("researcher", "Researcher", "research", "venice:chat+search", "0.05", "one-shot",
    "Researches a topic with web search + synthesis."),
  a("researcher-pro", "Premium Researcher", "research", "venice:reasoning", "0.09", "one-shot",
    "Deep research via a Venice reasoning model — higher quality."),
  a("copywriter", "Copywriter", "copy", "venice:chat", "0.04", "one-shot",
    "Writes the brief / marketing copy on the topic."),
  a("illustrator", "Illustrator", "image", "venice:image", "0.06", "one-shot",
    "Generates a cover image for the deliverable (fast)."),
  a("illustrator-pro", "Pro Illustrator", "image", "venice:image-4k", "0.15", "one-shot",
    "High-resolution cover art — premium image model."),
  a("analyst", "Analyst", "analysis", "venice:reasoning", "0.07", "one-shot",
    "Analyzes the topic + gives an outlook (reasoning model)."),
  a("onchain-scout", "Onchain Scout", "onchain", "venice:crypto-rpc", "0.05", "one-shot",
    "Pulls real on-chain data via Venice's RPC proxy (for crypto topics)."),
  a("narrator", "Narrator", "voice", "venice:tts", "0.07", "one-shot",
    "Speaks a summary of the deliverable — a playable voiceover (Venice TTS)."),

  // TRADING (one-shot) — a paid market-intelligence agent. The trade flow hires
  // it directly (not the research planner, which has no "scout" role); kept out
  // of the research marketplace via the discovery filter.
  a("yield-scout", "Yield Scout", "scout", "venice:chat+search", "0.06", "one-shot",
    "Picks the single best asset from your approved set, with live market reasoning."),

  // SUBSCRIPTION (recurring, X402SubscriptionEnforcer) — varied periods.
  a("pulse-feed", "Realtime Pulse Feed", "feed", "venice:chat", "0.01", "subscription",
    "Recurring real-time market-pulse updates (demo cadence: 60s).", sub("pulse-feed", 60)),
  a("daily-digest", "Daily AI Digest", "feed", "venice:chat+search", "0.10", "subscription",
    "A once-a-day AI/market digest.", sub("daily-digest", 86_400)),
  a("weekly-trends", "Weekly Trend Report", "feed", "venice:reasoning", "0.50", "subscription",
    "A weekly deep trend report.", sub("weekly-trends", 604_800)),
];

export const PROCUREMENT_AGENTS = AGENTS.filter((x) => x.paymentKind === "one-shot");
export const SUBSCRIPTION_AGENTS = AGENTS.filter((x) => x.paymentKind === "subscription");

export function getAgent(id: string): Agent | undefined {
  return AGENTS.find((x) => x.id === id);
}

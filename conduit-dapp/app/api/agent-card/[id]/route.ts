/**
 * GET /api/agent-card/[id] — serves the ERC-8004 Agent registration file
 * (AgentCard) for one Venice marketplace agent. This URL is registered on-chain
 * as the agent's `agentURI`; discovery + explorers resolve it from the registry.
 *
 * Shape follows the ERC-8004 spec exactly (type = registration-v1, services with
 * A2A/x402, registrations tying back to the on-chain agentId) so explorers render
 * it richly. Public + CORS-open so any discoverer can fetch it.
 */
import { NextResponse } from "next/server";
import { getAgent } from "@/lib/agents";
import { config } from "@/lib/config";

export const runtime = "nodejs";

const CAIP2 = `eip155:${config.chainId}`;

// ERC-8004 Identity Registry singletons (per chain).
const REGISTRIES: Record<number, string> = {
  84532: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
  8453: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
};

// On-chain agentIds from the Base Sepolia registration (so the card carries a
// verifiable `registrations` entry). Re-registration → update these.
const AGENT_IDS: Record<number, Record<string, number>> = {
  84532: {
    researcher: 6836, "researcher-pro": 6837, copywriter: 6838, illustrator: 6839,
    "illustrator-pro": 6840, analyst: 6841, "onchain-scout": 6842, narrator: 6843,
    "pulse-feed": 6844, "daily-digest": 6845, "weekly-trends": 6846,
  },
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export function GET(req: Request, { params }: { params: { id: string } }) {
  const agent = getAgent(params.id);
  if (!agent) {
    return NextResponse.json({ error: "unknown agent" }, { status: 404, headers: CORS });
  }
  const origin = new URL(req.url).origin;
  const cardUrl = `${origin}/api/agent-card/${agent.id}`;
  const registry = REGISTRIES[config.chainId];
  const agentId = AGENT_IDS[config.chainId]?.[agent.id];
  const unit = agent.paymentKind === "subscription" ? "period" : "request";

  const card = {
    // ERC-8004 registration file v1 — explorers key off this `type`.
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: agent.name,
    description:
      `${agent.description} Powered by ${agent.veniceEndpoint.replace(/^venice:/, "Venice ")}. ` +
      `${agent.priceUsdc} USDC per ${unit}, paid via x402 + ERC-7710 (intent-bound, gas in USDC via 1Shot).`,
    // Distinct per-agent avatar (robots = agents) so the marketplace isn't one logo.
    image: `https://api.dicebear.com/9.x/bottts/png?seed=${encodeURIComponent(agent.id)}`,
    // Standard NFT-metadata attributes → rendered as "Properties" on NFT explorers
    // like Basescan (the registry is an ERC-721). Harmless to ERC-8004 parsers.
    attributes: [
      { trait_type: "Role", value: agent.role },
      { trait_type: "Venice endpoint", value: agent.veniceEndpoint.replace(/^venice:/, "") },
      { trait_type: "Price", value: `${agent.priceUsdc} USDC / ${unit}` },
      { trait_type: "Payment", value: "x402 + ERC-7710" },
      { trait_type: "Settlement", value: "Conduit · gas in USDC (1Shot)" },
      { trait_type: "x402 support", value: "Yes" },
      { trait_type: "Trust", value: "On-chain payment binding" },
      ...(agent.subscription
        ? [{ trait_type: "Billing", value: `recurring · every ${agent.subscription.periodSeconds}s` }]
        : [{ trait_type: "Billing", value: "one-shot · intent-bound" }]),
    ],
    x402Support: true,
    active: true,
    // Honest: trust comes from the on-chain payment binding (X402ReceiptEnforcer),
    // not from the reputation/validation registries — so none of the standard
    // ERC-8004 trust models are claimed.
    supportedTrust: [],
    services: [
      // The AgentCard itself is the A2A interface (ERC-8004 extends A2A).
      { name: "A2A", endpoint: cardUrl, version: "0.3.0" },
      // The paid x402 + erc7710 resource on the Conduit seller.
      { name: "x402", endpoint: `${config.endpointUrl}${agent.resource}`, version: "2" },
      { name: "web", endpoint: origin },
    ],
    ...(agentId && registry
      ? { registrations: [{ agentId, agentRegistry: `${CAIP2}:${registry}` }] }
      : {}),
    // Conduit-specific marketplace metadata. `assetTransferMethod: erc7710` is the
    // operative bit — ANY erc7710-compatible facilitator can settle (the buyer
    // picks it; its redeemer comes from the 402 at pay-time). We name only the
    // reference facilitator we run (adds intent-binding + gas in USDC via 1Shot).
    conduit: {
      role: agent.role,
      veniceEndpoint: agent.veniceEndpoint,
      priceUsdc: agent.priceUsdc,
      paymentKind: agent.paymentKind,
      assetTransferMethod: "erc7710",
      network: CAIP2,
      facilitatorCompatibility: "any erc7710-compatible facilitator (e.g. MetaMask's hosted one)",
      referenceFacilitator: { name: "Conduit", url: config.facilitatorUrl, network: CAIP2 },
      ...(agent.subscription
        ? {
            subscription: {
              subscriptionId: agent.subscription.subscriptionId,
              periodSeconds: agent.subscription.periodSeconds,
            },
          }
        : {}),
    },
  };

  return NextResponse.json(card, { headers: CORS });
}

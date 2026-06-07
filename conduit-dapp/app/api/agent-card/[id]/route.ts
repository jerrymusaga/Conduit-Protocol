/**
 * GET /api/agent-card/[id] — serves a standards-compliant ERC-8004 AgentCard for
 * one Venice marketplace agent. This URL is what gets registered on-chain as the
 * agent's `agentURI`; discovery resolves it from the registry.
 *
 * The card advertises x402 + erc7710 with a FACILITATOR LIST (Conduit + MetaMask
 * hosted + any erc7710 facilitator), so the agent is facilitator-agnostic — a
 * buyer can settle via Conduit (intent-bound + gas in USDC) or any compliant
 * facilitator. Public + CORS-open so any discoverer can fetch it.
 */
import { NextResponse } from "next/server";
import { getAgent } from "@/lib/agents";
import { config } from "@/lib/config";

export const runtime = "nodejs";

const CAIP2 = `eip155:${config.chainId}`;

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

  const card = {
    type: "AgentCard",
    name: agent.name,
    description: agent.description,
    image: `${origin}/images/conduit-logo.png`,
    active: true,
    // Standard A2A/MCP-style service endpoints. The x402 endpoint is the paid
    // resource on the Conduit seller.
    services: [
      {
        name: "x402",
        endpoint: `${config.endpointUrl}${agent.resource}`,
        version: "2",
      },
    ],
    x402Support: true,
    // Conduit-specific marketplace metadata. `assetTransferMethod: erc7710` is
    // the operative bit — ANY erc7710-compatible facilitator can settle a payment
    // to this agent (the buyer picks the facilitator; its redeemer comes from the
    // 402 envelope at pay-time). We only name the reference facilitator we run,
    // which adds the X402ReceiptEnforcer intent-binding + gas in USDC via 1Shot.
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

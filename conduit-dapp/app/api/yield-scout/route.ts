/**
 * POST /api/yield-scout — the Yield Scout's REASONING step, powered by Venice.
 * Given the user's goal + the APPROVED venue set (the on-chain allowlist they
 * signed), Venice picks the single best lending venue RIGHT NOW (highest USDC
 * supply APY for the risk) with a concrete, data-backed rationale (web search on
 * for live rates). The choice is constrained to the signed set — the scout can
 * never reach beyond it.
 *
 * Best-effort: returns { pick: null } when Venice is unavailable, so the client
 * falls back to its deterministic scout. Key stays server-side.
 */
import { NextResponse } from "next/server";
import { veniceChat } from "@/lib/venice-server";

export const runtime = "nodejs";

interface VenueLite {
  name: string;
  protocol: string;
  note: string;
}

export async function POST(req: Request) {
  let goal = "";
  let venues: VenueLite[] = [];
  try {
    const b = (await req.json()) as { goal?: string; venues?: VenueLite[] };
    goal = b.goal ?? "";
    venues = Array.isArray(b.venues) ? b.venues : [];
  } catch {
    return NextResponse.json({ pick: null }, { status: 400 });
  }
  if (venues.length === 0) return NextResponse.json({ pick: null });

  const list = venues.map((v) => `- ${v.name} (${v.protocol}): ${v.note}`).join("\n");

  const text = await veniceChat(
    "You are a DeFi yield scout advising where to deposit USDC for the best return. From the " +
      "APPROVED VENUES below — and ONLY these — choose the SINGLE best one for the user's goal given " +
      "current USDC supply APYs and protocol risk. Be concrete: cite an approximate supply APY when you " +
      'can. Reply with ONLY JSON, no prose: {"name":"<exact name from the list>","apyBps":<integer basis points or null>,"reason":"<1-2 sentences>"}.',
    `Goal: "${goal}"\n\nApproved venues (pick exactly one):\n${list}`,
    { maxTokens: 350, model: "llama-3.3-70b", webSearch: "on" }
  );
  if (!text) return NextResponse.json({ pick: null });

  try {
    const m = text.match(/\{[\s\S]*\}/);
    const parsed = m ? (JSON.parse(m[0]) as { name?: unknown; apyBps?: unknown; reason?: unknown }) : null;
    const name = typeof parsed?.name === "string" ? parsed.name.trim() : "";
    const match = venues.find(
      (v) => v.name.toLowerCase() === name.toLowerCase() || v.protocol.toLowerCase().includes(name.toLowerCase())
    );
    if (!match) return NextResponse.json({ pick: null });
    return NextResponse.json({
      pick: {
        name: match.name,
        apyBps: typeof parsed?.apyBps === "number" ? Math.round(parsed.apyBps) : undefined,
        reason: typeof parsed?.reason === "string" ? parsed.reason.trim() : "",
      },
    });
  } catch {
    return NextResponse.json({ pick: null });
  }
}

/**
 * POST /api/scout — the Yield Scout's REASONING step, powered by Venice. Given
 * the user's goal + the APPROVED token set (the on-chain allowlist they signed),
 * Venice picks the single best asset RIGHT NOW with a concrete, data-backed
 * rationale (web search on for live conditions). The choice is constrained to the
 * signed set — the scout can never reach beyond it.
 *
 * Best-effort: returns { pick: null } when Venice is unavailable, so the client
 * falls back to its deterministic scout. Key stays server-side.
 */
import { NextResponse } from "next/server";
import { veniceChat } from "@/lib/venice-server";

export const runtime = "nodejs";

interface TokenLite {
  name: string;
  symbol: string;
  note: string;
}

export async function POST(req: Request) {
  let goal = "";
  let tokens: TokenLite[] = [];
  try {
    const b = (await req.json()) as { goal?: string; tokens?: TokenLite[] };
    goal = b.goal ?? "";
    tokens = Array.isArray(b.tokens) ? b.tokens : [];
  } catch {
    return NextResponse.json({ pick: null }, { status: 400 });
  }
  if (tokens.length === 0) return NextResponse.json({ pick: null });

  const list = tokens.map((t) => `- ${t.name} (${t.symbol}): ${t.note}`).join("\n");

  const text = await veniceChat(
    "You are a crypto market & yield scout advising on which asset to buy. From the APPROVED " +
      "ASSETS below — and ONLY these — choose the SINGLE best one for the user's goal given current " +
      "market and staking conditions. Be concrete: cite a figure (e.g. an APR or a recent move) when " +
      'you can. Reply with ONLY JSON, no prose: {"symbol":"<exact symbol from the list>","reason":"<1-2 sentences>"}.',
    `Goal: "${goal}"\n\nApproved assets (pick exactly one):\n${list}`,
    { maxTokens: 350, model: "llama-3.3-70b", webSearch: "on" }
  );
  if (!text) return NextResponse.json({ pick: null });

  try {
    const m = text.match(/\{[\s\S]*\}/);
    const parsed = m ? (JSON.parse(m[0]) as { symbol?: unknown; reason?: unknown }) : null;
    const sym = typeof parsed?.symbol === "string" ? parsed.symbol.trim() : "";
    const match = tokens.find(
      (t) => t.symbol.toLowerCase() === sym.toLowerCase() || t.name.toLowerCase() === sym.toLowerCase()
    );
    if (!match) return NextResponse.json({ pick: null });
    return NextResponse.json({
      pick: {
        symbol: match.symbol,
        name: match.name,
        reason: typeof parsed?.reason === "string" ? parsed.reason.trim() : "",
      },
    });
  } catch {
    return NextResponse.json({ pick: null });
  }
}

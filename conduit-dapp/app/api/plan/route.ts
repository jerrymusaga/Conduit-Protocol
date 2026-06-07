/**
 * POST /api/plan — the coordinator's REASONING step, powered by Venice. Given
 * the user's request + the discovered marketplace, Venice picks the best agent
 * for each capability the task needs and returns a structured plan with a short
 * rationale per pick. The coordinator (client) then hires + pays each.
 *
 * Best-effort: returns { picks: null } when Venice is unavailable, so the
 * coordinator falls back to its deterministic planner. Key stays server-side.
 */
import { NextResponse } from "next/server";
import { veniceChat } from "@/lib/venice-server";

export const runtime = "nodejs";

interface AgentLite {
  id: string;
  name: string;
  role: string;
  priceUsdc: string;
  description: string;
}

export async function POST(req: Request) {
  let prompt = "";
  let agents: AgentLite[] = [];
  try {
    const b = (await req.json()) as { prompt?: string; agents?: AgentLite[] };
    prompt = b.prompt ?? "";
    agents = Array.isArray(b.agents) ? b.agents : [];
  } catch {
    return NextResponse.json({ picks: null }, { status: 400 });
  }
  if (agents.length === 0) return NextResponse.json({ picks: null });

  const list = agents
    .map((a) => `- id:${a.id} · ${a.name} · role:${a.role} · $${a.priceUsdc} · ${a.description}`)
    .join("\n");

  const text = await veniceChat(
    "You are a procurement coordinator agent assembling a team to fulfill a user's request. " +
      "From the MARKETPLACE below, pick the BEST agent for each capability the task needs. " +
      "ALWAYS include a researcher (to ground the work) and a narrator (for a voiceover summary). " +
      "Add a copywriter, illustrator, analyst, or on-chain data agent ONLY if the task needs it. " +
      "Prefer best value unless the user explicitly asks for premium / high quality / 4k. " +
      'Reply with ONLY JSON, no prose: {"picks":[{"id":"<marketplace id>","reason":"<one short reason>"}]}. ' +
      "Use ids exactly as they appear in the marketplace.",
    `Request: "${prompt}"\n\nMarketplace:\n${list}`,
    { maxTokens: 500 }
  );
  if (!text) return NextResponse.json({ picks: null });

  try {
    const m = text.match(/\{[\s\S]*\}/);
    const parsed = m ? (JSON.parse(m[0]) as { picks?: { id?: unknown; reason?: unknown }[] }) : null;
    const ids = new Set(agents.map((a) => a.id));
    const picks = Array.isArray(parsed?.picks)
      ? parsed!.picks
          .filter((p) => p && typeof p.id === "string" && ids.has(p.id))
          .map((p) => ({ id: p.id as string, reason: typeof p.reason === "string" ? p.reason : undefined }))
      : null;
    return NextResponse.json({ picks: picks && picks.length ? picks : null });
  } catch {
    return NextResponse.json({ picks: null });
  }
}

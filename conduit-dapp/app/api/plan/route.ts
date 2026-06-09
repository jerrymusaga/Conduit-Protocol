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
      "From the MARKETPLACE below, pick ONLY the agents whose capability the task actually requires — " +
      "a lean team that matches THIS request, not a default bundle. " +
      "ALWAYS include a researcher (to ground the work) and a narrator (for a voiceover summary). " +
      "Add the OTHER specialists ONLY when the request clearly calls for them:\n" +
      "- copywriter: ONLY when the user asks for written copy — marketing, a brief, positioning, " +
      "an announcement, a tagline, a pitch. A research / analysis / data / trading task does NOT need a copywriter.\n" +
      "- illustrator: ONLY when the user asks for an image, cover, visual, logo, or design.\n" +
      "- analyst: ONLY when the user asks for analysis, comparison, market/competitive insight, or strategy.\n" +
      "- on-chain data agent: ONLY when the user asks about crypto, tokens, staking, DeFi, yields, on-chain/blockchain data.\n" +
      "When in doubt, LEAVE A SPECIALIST OUT. Prefer best value unless the user explicitly asks for premium / high quality / 4k. " +
      'Reply with ONLY JSON, no prose: {"picks":[{"id":"<marketplace id>","reason":"<one short reason>"}]}. ' +
      "Use ids exactly as they appear in the marketplace.",
    `Request: "${prompt}"\n\nMarketplace:\n${list}`,
    // Team selection is a fast routing decision, not a deep reasoning task.
    // gemini-3-5-flash returns a clean structured plan in ~3s and follows the
    // strict allowlist well; glm-5-1 (even at low reasoning) took 10-15s on every
    // run — the single biggest fixed latency on the path. No reasoning needed.
    { maxTokens: 400, model: "gemini-3-5-flash" }
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

/**
 * POST /api/report — aggregate the purchased provider outputs into a polished
 * markdown report via Venice chat (the coordinator's final synthesis step).
 *
 * Body: { prompt, sections: [{ agent, label, priceUsdc, output }] }
 * Returns: { markdown } — or { markdown: null } when Venice is unavailable, so
 * the client falls back to its deterministic section rendering.
 */
import { NextResponse } from "next/server";
import { veniceChat } from "@/lib/venice-server";

export const runtime = "nodejs";

interface Section {
  agent: string;
  label: string;
  priceUsdc: string;
  output?: { type?: string; content?: unknown; source?: string };
}

export async function POST(req: Request) {
  let prompt = "";
  let sections: Section[] = [];
  try {
    const body = (await req.json()) as { prompt?: string; sections?: Section[] };
    prompt = body.prompt ?? "";
    sections = Array.isArray(body.sections) ? body.sections : [];
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (sections.length === 0) {
    return NextResponse.json({ markdown: null });
  }

  // Lay out the raw purchased material for the model to synthesize.
  const material = sections
    .map((s) => {
      const c = s.output?.content;
      const body = typeof c === "string" ? c : JSON.stringify(c, null, 2);
      return `### ${s.label} (${s.priceUsdc} USDC${s.output?.source ? ` · ${s.output.source}` : ""})\n${body}`;
    })
    .join("\n\n");

  const markdown = await veniceChat(
    "You are a procurement coordinator agent assembling a market report from data " +
      "purchased from independent provider agents. Write a clean, professional markdown " +
      "report. Use a short title (H1), an executive summary, then one section per provider. " +
      "Do NOT invent numbers — use only what's provided. Keep it tight (under 350 words). " +
      "End with a one-line note that every input was paid for under a single bounded, " +
      "revocable budget enforced on-chain by Conduit.",
    `User request: "${prompt}"\n\nPurchased material:\n\n${material}`,
    { maxTokens: 900 }
  );

  return NextResponse.json({ markdown });
}

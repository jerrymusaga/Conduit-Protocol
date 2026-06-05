/**
 * POST /api/cover — generate a report cover image via Venice (/image/generate).
 * The visual "product" payoff: the deliverable the agent bought, rendered.
 *
 * Body: { title?: string }
 * Returns: { image } — a data: URL, or { image: null } when Venice is
 * unavailable so the client simply omits the cover.
 */
import { NextResponse } from "next/server";
import { veniceImage } from "@/lib/venice-server";

export const runtime = "nodejs";

export async function POST(req: Request) {
  let title = "ETH Staking Market Report";
  try {
    const body = (await req.json()) as { title?: string };
    if (body.title) title = body.title;
  } catch {
    /* default title */
  }

  const prompt =
    `Editorial cover illustration for a financial intelligence report titled "${title}". ` +
    "Abstract Ethereum staking theme: flowing data, validator nodes, deep navy and black " +
    "background with cyan, violet and magenta gradient accents. Clean, modern, high-end " +
    "fintech aesthetic. No text, no words, no letters.";

  const image = await veniceImage(prompt);
  return NextResponse.json({ image });
}

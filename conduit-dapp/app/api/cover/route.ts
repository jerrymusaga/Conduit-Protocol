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
  let title = "Creative Brief";
  try {
    const body = (await req.json()) as { title?: string };
    if (body.title && body.title.trim()) title = body.title.trim().slice(0, 200);
  } catch {
    /* default title */
  }

  // Topic-driven: the cover should visually capture WHATEVER the deliverable is
  // about (from its title), not a fixed theme.
  const prompt =
    `Editorial cover illustration that visually captures the theme of "${title}". ` +
    "Modern, abstract and conceptual — evoke the subject through composition, shapes and " +
    "imagery, not literally. High-end magazine / premium report aesthetic on a deep dark " +
    "background, with tasteful cyan, violet and magenta gradient accents. Clean, striking, " +
    "uncluttered. Absolutely no text, no words, no letters, no numbers.";

  const image = await veniceImage(prompt);
  return NextResponse.json({ image });
}

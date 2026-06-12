/**
 * One-off: generate the three subscription product cover images via Venice
 * (/image/generate) and save them to public/images/. Run once; the PNGs are
 * then committed and served statically (no per-render Venice call).
 *
 *   VENICE_API_KEY=… node scripts/gen-product-images.mjs
 * (reads VENICE_API_KEY from .env.local if not already in the environment)
 */
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

// Load VENICE_API_KEY from .env.local if not in env.
if (!process.env.VENICE_API_KEY && existsSync(join(root, ".env.local"))) {
  for (const line of readFileSync(join(root, ".env.local"), "utf8").split("\n")) {
    const m = line.match(/^VENICE_API_KEY=(.*)$/);
    if (m) process.env.VENICE_API_KEY = m[1].trim().replace(/^["']|["']$/g, "");
  }
}
const KEY = process.env.VENICE_API_KEY;
if (!KEY) throw new Error("set VENICE_API_KEY (or put it in conduit-dapp/.env.local)");

const BASE = "https://api.venice.ai/api/v1";
const MODEL = "z-image-turbo";
const accent =
  "Deep near-black background with tasteful cyan, violet and magenta gradient accents. " +
  "Modern, abstract, conceptual, premium fintech aesthetic. Clean and uncluttered. " +
  "Absolutely no text, no words, no letters, no numbers, no charts with labels.";

const products = [
  { file: "product-pulse.png", prompt: `A single luminous market heartbeat / pulse line surging across a dark field, one decisive upward spike. ${accent}` },
  { file: "product-alpha.png", prompt: `An abstract glowing neural brain made of interconnected nodes and crypto-signal sparks, the idea of daily AI market intelligence. ${accent}` },
  { file: "product-yield.png", prompt: `Abstract golden stacked layers / vaults growing upward like compounding yield, a sense of on-chain returns accruing. Emerald and gold accents over ${accent}` },
];

for (const p of products) {
  process.stdout.write(`generating ${p.file} … `);
  const res = await fetch(`${BASE}/image/generate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, prompt: p.prompt, width: 1024, height: 1024, format: "png", safe_mode: true, return_binary: false }),
  });
  if (!res.ok) {
    console.log(`FAILED ${res.status}: ${await res.text()}`);
    continue;
  }
  const json = await res.json();
  const b64 = json.images?.[0];
  if (!b64) {
    console.log("no image in response");
    continue;
  }
  writeFileSync(join(root, "public", "images", p.file), Buffer.from(b64, "base64"));
  console.log("saved");
}

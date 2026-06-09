import crypto from "node:crypto";
import stableStringify from "safe-stable-stringify";

/**
 * Verifies inbound 1Shot relayer webhooks (Ed25519). The relayer signs the
 * canonical JSON of the body WITHOUT the `signature` field, using a key
 * published at its JWKS endpoint. We verify with Node's built-in crypto (no new
 * deps) and a stable, sorted-key serializer.
 *
 * Protocol (from the public-relayer skill reference):
 *   1. Look up the public key by `body.keyId` in /.well-known/jwks.json.
 *   2. Strip `signature`, serialize the rest with sorted keys.
 *   3. Verify the base64 Ed25519 signature over the UTF-8 bytes.
 */

export interface WebhookEvent {
  apiVersion: number;
  eventName:
    | "TransactionExecutionSubmitted"
    | "TransactionExecutionSuccess"
    | "TransactionExecutionFailure"
    | "WalletLowBalanceDetected";
  data: Record<string, unknown>;
  timestamp: number;
  keyId: string;
  signature: string;
}

/** Stable, sorted-key JSON (recursively) — must match the relayer's canonical form. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

// --- JWKS cache ------------------------------------------------------------

interface Jwk { kty: string; crv: string; kid: string; x: string }
const jwksCaches = new Map<string, { fetchedAt: number; keys: Map<string, crypto.KeyObject> }>();
const JWKS_TTL_MS = 10 * 60_000;

/** The 1Shot relayers appear to publish webhook signing keys on the PROD JWKS
 *  (the public-relayer skill example hardcodes .com even for testnet), so we
 *  always try this in addition to the relayer-derived URL. */
const PROD_JWKS_URL = "https://relayer.1shotapi.com/.well-known/jwks.json";

/** Derive the JWKS URL from the relayer base (…/relayers → …/.well-known/jwks.json). */
export function jwksUrlFor(relayerUrl: string): string {
  const u = new URL(relayerUrl);
  return `${u.origin}/.well-known/jwks.json`;
}

async function getKeys(jwksUrl: string, force = false): Promise<Map<string, crypto.KeyObject>> {
  const cached = jwksCaches.get(jwksUrl);
  if (!force && cached && Date.now() - cached.fetchedAt < JWKS_TTL_MS) {
    return cached.keys;
  }
  const res = await fetch(jwksUrl);
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const { keys } = (await res.json()) as { keys: Jwk[] };
  const map = new Map<string, crypto.KeyObject>();
  for (const k of keys) {
    if (k.kty === "OKP" && k.crv === "Ed25519") {
      map.set(
        k.kid,
        crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: k.x }, format: "jwk" })
      );
    }
  }
  jwksCaches.set(jwksUrl, { fetchedAt: Date.now(), keys: map });
  return map;
}

/** An explicitly-configured Ed25519 webhook public key (base64 / base64url raw
 *  32-byte key), the path other integrators use. Overrides/augments the JWKS. */
function envPublicKey(): crypto.KeyObject | null {
  const raw = process.env.ONESHOT_WEBHOOK_PUBLIC_KEY?.trim();
  if (!raw) return null;
  try {
    const x = raw.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); // → base64url for JWK
    return crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" });
  } catch (e) {
    console.warn(`[webhook-verify] bad ONESHOT_WEBHOOK_PUBLIC_KEY: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

/** Gather every candidate public key for `keyId`: the relayer-derived JWKS, the
 *  PROD JWKS, and an explicit env-var key. We were likely verifying with the
 *  wrong key (the .dev JWKS) all along. */
async function candidateKeys(keyId: string, jwksUrl: string): Promise<{ src: string; key: crypto.KeyObject }[]> {
  const out: { src: string; key: crypto.KeyObject }[] = [];
  for (const url of [...new Set([jwksUrl, PROD_JWKS_URL])]) {
    try {
      let keys = await getKeys(url);
      let k = keys.get(keyId);
      if (!k) {
        keys = await getKeys(url, true);
        k = keys.get(keyId);
      }
      if (k) out.push({ src: url, key: k });
    } catch (e) {
      console.warn(`[webhook-verify] JWKS fetch failed (${url}): ${e instanceof Error ? e.message : e}`);
    }
  }
  const env = envPublicKey();
  if (env) out.push({ src: "env:ONESHOT_WEBHOOK_PUBLIC_KEY", key: env });
  return out;
}

/**
 * Verify a webhook body. Returns true iff the Ed25519 signature is valid for the
 * canonical (signature-stripped) body under the key named by `keyId`.
 */
export async function verifyWebhook(
  body: Record<string, unknown>,
  jwksUrl: string,
  rawBody?: string
): Promise<boolean> {
  const sigB64 = typeof body.signature === "string" ? body.signature : undefined;
  const keyId = typeof body.keyId === "string" ? body.keyId : undefined;
  if (!sigB64 || !keyId) {
    console.warn(`[webhook-verify] missing ${!sigB64 ? "signature" : "keyId"} in body`);
    return false;
  }

  // Try EVERY candidate public key (relayer JWKS, prod JWKS, env-var) — we were
  // likely verifying with the wrong key (the .dev JWKS) the whole time.
  const keyCandidates = await candidateKeys(keyId, jwksUrl);
  if (keyCandidates.length === 0) {
    console.warn(`[webhook-verify] no public key for keyId "${keyId}" in any source`);
    return false;
  }

  const { signature: _omit, ...rest } = body;
  // Normalize base64url → base64 so either signature encoding decodes.
  const sig = Buffer.from(sigB64.replace(/-/g, "+").replace(/_/g, "/"), "base64");

  // The relayer signs the body MINUS `signature`. We don't know its exact
  // serializer (the skill docs' sorted "safe-stable-stringify" is wrong — the
  // wire order is type,data,timestamp,keyId,apiVersion, and even original-order
  // JS compact didn't match → likely different whitespace/encoding). So try, in
  // order of likelihood:
  //   1. RAW bytes with the `signature` field surgically removed — the relayer's
  //      LITERAL serialization, so whitespace/encoding match exactly.
  //   2. JS compact (original key order).
  //   3. Python-style json.dumps spacing (", " / ": "), original order.
  //   4. Sorted canonical (the documented-but-wrong form).
  const candidates: Array<[string, string]> = [];
  // THE canonical form, confirmed by 1Shot's own verifier code: the relayer
  // signs safe-stable-stringify(body minus signature). Their wire JSON order can
  // differ, so we must RE-serialize with this exact lib (our hand-rolled sorted
  // form didn't match its output). Everything below is just defensive fallback.
  const stable = stableStringify(rest) ?? "";
  candidates.push(["safe-stable", stable]);
  // 1Shot's relayer currently DOUBLE-serializes when signing —
  // stringify(stringify(payload)) — a confirmed bug (fix incoming). Accept both
  // the double form (works now) and the single form (works post-fix), so the
  // webhook keeps verifying straight through their rollout.
  candidates.push(["safe-stable-double", stableStringify(stable) ?? ""]);
  if (rawBody) {
    // Literal bytes, signature value emptied in place (common: sign with
    // `"signature":""`, then fill the value) — highest fidelity.
    const emptied = rawBody.replace(/("signature"\s*:\s*")[^"]*"/, '$1"');
    if (emptied !== rawBody) candidates.push(["raw-empty-sig", emptied]);
    // Literal bytes, signature field removed entirely.
    const stripped = stripSignatureField(rawBody);
    if (stripped) candidates.push(["raw-stripped", stripped]);
  }
  candidates.push(["json-empty-sig", JSON.stringify({ ...rest, signature: "" })]);
  candidates.push(["json-compact", JSON.stringify(rest)]);
  candidates.push(["python-spaces", pythonJson(rest)]);
  candidates.push(["sorted", canonicalJson(rest)]);
  // Charlie confirmed: body minus signature, SORTED. Our compact-sorted failed,
  // so the relayer likely serializes sorted WITH Python json.dumps spacing
  // (", " / ": "). Also try sorted-with-empty-signature.
  candidates.push(["sorted-spaces", pythonJson(sortKeys(rest))]);
  candidates.push(["sorted-empty-sig", canonicalJson({ ...rest, signature: "" })]);
  candidates.push(["sorted-spaces-empty-sig", pythonJson(sortKeys({ ...rest, signature: "" }))]);

  for (const { src, key } of keyCandidates) {
    for (const [label, message] of candidates) {
      try {
        if (crypto.verify(null, Buffer.from(message, "utf8"), key, sig)) {
          console.log(`[webhook-verify] OK via key=${src} form="${label}"`);
          return true;
        }
      } catch (e) {
        console.warn(`[webhook-verify] crypto.verify threw: ${e instanceof Error ? e.message : e}`);
      }
    }
  }
  console.warn(
    `[webhook-verify] Ed25519 verify=false · keys=[${keyCandidates.map((k) => k.src).join(", ")}] · ` +
      `FULLRAW=${rawBody ?? JSON.stringify(body)}`
  );
  return false;
}

/** Remove the trailing `,"signature":"…"` field from the raw JSON body, yielding
 *  the exact bytes the relayer signed (signature is the last field on the wire). */
function stripSignatureField(raw: string): string | null {
  const m = raw.match(/^([\s\S]*?),\s*"signature"\s*:\s*"[^"]*"\s*\}\s*$/);
  return m ? `${m[1]}}` : null;
}

/** Mimic Python's json.dumps default: ", " / ": " separators, insertion order,
 *  no sorting (some signers use Python's stdlib serializer). */
function pythonJson(value: unknown): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "number" || t === "boolean") return String(value);
  if (t === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(pythonJson).join(", ")}]`;
  if (t === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${JSON.stringify(k)}: ${pythonJson(v)}`)
      .join(", ")}}`;
  }
  return "null";
}

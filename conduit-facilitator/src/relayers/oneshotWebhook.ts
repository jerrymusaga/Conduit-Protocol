import crypto from "node:crypto";

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
let jwksCache: { fetchedAt: number; keys: Map<string, crypto.KeyObject> } | null = null;
const JWKS_TTL_MS = 10 * 60_000;

/** Derive the JWKS URL from the relayer base (…/relayers → …/.well-known/jwks.json). */
export function jwksUrlFor(relayerUrl: string): string {
  const u = new URL(relayerUrl);
  return `${u.origin}/.well-known/jwks.json`;
}

async function getKeys(jwksUrl: string, force = false): Promise<Map<string, crypto.KeyObject>> {
  if (!force && jwksCache && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS) {
    return jwksCache.keys;
  }
  const res = await fetch(jwksUrl);
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const { keys } = (await res.json()) as { keys: Jwk[] };
  const map = new Map<string, crypto.KeyObject>();
  for (const k of keys) {
    if (k.kty === "OKP" && k.crv === "Ed25519") {
      map.set(
        k.kid,
        crypto.createPublicKey({
          key: { kty: "OKP", crv: "Ed25519", x: k.x },
          format: "jwk",
        })
      );
    }
  }
  jwksCache = { fetchedAt: Date.now(), keys: map };
  return map;
}

/**
 * Verify a webhook body. Returns true iff the Ed25519 signature is valid for the
 * canonical (signature-stripped) body under the key named by `keyId`.
 */
export async function verifyWebhook(
  body: Record<string, unknown>,
  jwksUrl: string
): Promise<boolean> {
  const sigB64 = typeof body.signature === "string" ? body.signature : undefined;
  const keyId = typeof body.keyId === "string" ? body.keyId : undefined;
  if (!sigB64 || !keyId) return false;

  let keys = await getKeys(jwksUrl);
  let pub = keys.get(keyId);
  if (!pub) {
    keys = await getKeys(jwksUrl, true); // force-refresh on miss (key rotation)
    pub = keys.get(keyId);
    if (!pub) return false;
  }

  const { signature: _omit, ...rest } = body;
  const message = Buffer.from(canonicalJson(rest), "utf8");
  const sig = Buffer.from(sigB64, "base64");
  try {
    return crypto.verify(null, message, pub, sig);
  } catch {
    return false;
  }
}

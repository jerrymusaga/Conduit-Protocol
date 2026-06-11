/**
 * Server-side store for the passkey wallet (Upstash Redis). Holds two things:
 *   - WebAuthn challenges (short TTL) keyed by a server-issued challengeId, so
 *     the routes stay stateless (the client echoes the id back on verify).
 *   - Credential records (the WebAuthn public key + counter + the derived EVM
 *     address). The server NEVER sees the private key — it's derived client-side
 *     in the wallet iframe from the PRF output.
 *
 * Env: UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN (Redis.fromEnv()).
 */
import "server-only";
import { Redis } from "@upstash/redis";

// Lazily create the client so a missing UPSTASH_* env var can't throw at module
// load (which would fail `next build`). The routes only touch Redis when called.
let _redis: Redis | null = null;
function getRedis(): Redis {
  if (!_redis) _redis = Redis.fromEnv();
  return _redis;
}
const CHALLENGE_TTL_SECONDS = 60;

const chalKey = (id: string) => `pk:chal:${id}`;
const credKey = (id: string) => `pk:cred:${id}`;

export async function putChallenge(id: string, challenge: string): Promise<void> {
  await getRedis().set(chalKey(id), challenge, { ex: CHALLENGE_TTL_SECONDS });
}

/** Read + consume a challenge (single-use). */
export async function takeChallenge(id: string): Promise<string | null> {
  const key = chalKey(id);
  const challenge = await getRedis().get<string>(key);
  if (challenge) await getRedis().del(key);
  return challenge ?? null;
}

/** How the EVM key is held for this credential:
 *  - prf:       derived on demand from the authenticator's PRF output
 *  - credBlob:  the 32-byte key is stored inside the credential (read every auth)
 *  - largeBlob: the key is stored in the credential's large blob (write-once, read after)
 */
export type CredentialMode = "prf" | "credBlob" | "largeBlob";

export interface StoredCredential {
  /** base64url credential id (the WebAuthn credential.id). */
  id: string;
  /** base64 COSE public key. */
  publicKey: string;
  /** Signature counter (replay protection; 0 for many platform authenticators). */
  counter: number;
  /** The EVM address. For LongBlob modes it's known at registration; for PRF it's
   *  filled on first authentication (it comes from the PRF output). */
  address: `0x${string}` | null;
  /** Which key-holding mode this credential uses (set at registration). */
  mode?: CredentialMode;
}

export async function putCredential(cred: StoredCredential): Promise<void> {
  await getRedis().set(credKey(cred.id), cred);
}

export async function getCredential(id: string): Promise<StoredCredential | null> {
  return (await getRedis().get<StoredCredential>(credKey(id))) ?? null;
}

/** Update the counter (and address, once derived) after a successful auth. */
export async function updateCredential(
  id: string,
  patch: Partial<Pick<StoredCredential, "counter" | "address">>
): Promise<void> {
  const cur = await getCredential(id);
  if (!cur) return;
  await getRedis().set(credKey(id), { ...cur, ...patch });
}

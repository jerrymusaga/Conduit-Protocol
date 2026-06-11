/**
 * POST /api/passkey/register/options — issue WebAuthn registration options for a
 * NEW passkey wallet. Discoverable (resident) credential so login later needs no
 * username; PRF extension requested so the credential can derive an EVM key. The
 * challenge is stashed in Upstash under a server-issued id the client echoes back.
 */
import { NextResponse } from "next/server";
import { generateRegistrationOptions } from "@simplewebauthn/server";
import { RP_ID, RP_NAME, PRF_SALT } from "@/lib/passkey/config";
import { putChallenge } from "@/lib/passkey/store";

export const runtime = "nodejs";

export async function POST() {
  try {
    const prfFirst = Buffer.from(PRF_SALT).toString("base64url");
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: RP_ID,
      userName: `conduit-${Date.now().toString(36)}`,
      attestationType: "none",
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required",
      },
      supportedAlgorithmIDs: [-7, -257], // ES256, RS256
      // The PRF salt triggers the extension at credential creation. Key
      // derivation itself happens at auth time with the constant label.
      extensions: { prf: { eval: { first: prfFirst } } } as unknown as Record<string, unknown>,
    });

    const challengeId = crypto.randomUUID();
    await putChallenge(challengeId, options.challenge);
    return NextResponse.json({ ...options, challengeId });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: "couldn't create registration options", detail }, { status: 500 });
  }
}

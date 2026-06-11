/**
 * POST /api/passkey/auth/options — issue WebAuthn authentication options for an
 * existing passkey wallet. Discoverable, so no allowCredentials (the authenticator
 * surfaces the resident credential). PRF eval requested so the client can derive
 * the EVM key from the PRF output.
 */
import { NextResponse } from "next/server";
import { generateAuthenticationOptions } from "@simplewebauthn/server";
import { RP_ID, PRF_SALT } from "@/lib/passkey/config";
import { putChallenge } from "@/lib/passkey/store";

export const runtime = "nodejs";

export async function POST() {
  try {
    const prfFirst = Buffer.from(PRF_SALT).toString("base64url");
    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      userVerification: "required",
      extensions: { prf: { eval: { first: prfFirst } } } as unknown as Record<string, unknown>,
    });

    const challengeId = crypto.randomUUID();
    await putChallenge(challengeId, options.challenge);
    return NextResponse.json({ ...options, challengeId });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: "couldn't create auth options", detail }, { status: 500 });
  }
}

/**
 * POST /api/passkey/register/verify — verify the registration response and store
 * the credential (public key + counter). The EVM address isn't known yet — it's
 * derived from the PRF output at first authentication — so it's stored null here.
 *
 * Body: { credential: RegistrationResponseJSON, challengeId: string }
 */
import { NextResponse } from "next/server";
import { verifyRegistrationResponse } from "@simplewebauthn/server";
import { RP_ID, RP_ORIGIN } from "@/lib/passkey/config";
import { takeChallenge, putCredential } from "@/lib/passkey/store";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { credential?: unknown; challengeId?: string };
    if (!body.credential || !body.challengeId) {
      return NextResponse.json({ error: "credential and challengeId are required" }, { status: 400 });
    }
    const expectedChallenge = await takeChallenge(body.challengeId);
    if (!expectedChallenge) {
      return NextResponse.json({ error: "challenge not found or expired" }, { status: 400 });
    }

    const verification = await verifyRegistrationResponse({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      response: body.credential as any,
      expectedChallenge,
      expectedOrigin: RP_ORIGIN,
      expectedRPID: RP_ID,
      requireUserVerification: true,
    });

    if (!verification.verified || !verification.registrationInfo) {
      return NextResponse.json({ error: "registration verification failed" }, { status: 400 });
    }

    const { credential } = verification.registrationInfo; // v13: { id, publicKey, counter }
    await putCredential({
      id: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString("base64"),
      counter: credential.counter,
      address: null,
    });
    return NextResponse.json({ verified: true, credentialId: credential.id });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: "registration verify failed", detail }, { status: 500 });
  }
}

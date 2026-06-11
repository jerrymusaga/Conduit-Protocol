/**
 * POST /api/passkey/auth/verify — verify the authentication response against the
 * stored credential, bump the counter, and persist the EVM address the client
 * derived from the PRF output (first login fills it). The server never sees the
 * key; it only confirms the passkey is genuine and records the public address.
 *
 * Body: { credential: AuthenticationResponseJSON, challengeId: string, address?: `0x${string}` }
 */
import { NextResponse } from "next/server";
import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import { RP_ID, RP_ORIGIN } from "@/lib/passkey/config";
import { takeChallenge, getCredential, updateCredential } from "@/lib/passkey/store";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      credential?: { id?: string };
      challengeId?: string;
      address?: `0x${string}`;
    };
    if (!body.credential?.id || !body.challengeId) {
      return NextResponse.json({ error: "credential and challengeId are required" }, { status: 400 });
    }
    const expectedChallenge = await takeChallenge(body.challengeId);
    if (!expectedChallenge) {
      return NextResponse.json({ error: "challenge not found or expired" }, { status: 400 });
    }
    const stored = await getCredential(body.credential.id);
    if (!stored) {
      return NextResponse.json({ error: "unknown credential" }, { status: 404 });
    }

    const verification = await verifyAuthenticationResponse({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      response: body.credential as any,
      expectedChallenge,
      expectedOrigin: RP_ORIGIN,
      expectedRPID: RP_ID,
      credential: {
        id: stored.id,
        publicKey: new Uint8Array(Buffer.from(stored.publicKey, "base64")),
        counter: stored.counter,
      },
      requireUserVerification: true,
    });

    if (!verification.verified) {
      return NextResponse.json({ error: "authentication verification failed" }, { status: 400 });
    }

    await updateCredential(stored.id, {
      counter: verification.authenticationInfo.newCounter,
      address: body.address ?? stored.address,
    });
    return NextResponse.json({ verified: true });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: "auth verify failed", detail }, { status: 500 });
  }
}

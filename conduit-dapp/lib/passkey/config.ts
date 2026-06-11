/**
 * Passkey (WebAuthn PRF) wallet config. Shared by the iframe (client), the
 * connect UI, and the WebAuthn server routes.
 *
 * The RP id is the domain (no scheme, no port) and MUST equal the page's
 * hostname; the origin is the full origin. Set both per-environment:
 *   - local:  RP_ID=localhost                RP_ORIGIN=http://localhost:3000
 *   - vercel: RP_ID=conduit-protocol.vercel.app  RP_ORIGIN=https://conduit-protocol.vercel.app
 */
export const RP_NAME = "Conduit";

/** Domain only (no scheme/port). Defaults to localhost for dev. */
export const RP_ID = process.env.NEXT_PUBLIC_RP_ID || "localhost";

/** Full origin the WebAuthn ceremony runs on. */
export const RP_ORIGIN = process.env.NEXT_PUBLIC_RP_ORIGIN || "http://localhost:3000";

/**
 * The forever-stable, versioned key-derivation label. The passkey-derived EVM
 * key is HKDF'd from the PRF output using this as the `info`. CHANGING IT AFTER
 * USERS REGISTER PERMANENTLY BREAKS THEIR WALLETS — version it (`-v1`), never edit.
 */
export const ETH_KEY_DERIVATION_LABEL = "protocol.conduit.eth-key-v1";

/** The PRF eval input ("salt") — a constant per app; the same input + same
 *  credential always yields the same PRF output → the same wallet. */
export const PRF_SALT = "conduit-prf-salt-v1";

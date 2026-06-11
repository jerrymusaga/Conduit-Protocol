"use client";
/**
 * The ISOLATED passkey wallet iframe (Conduit). The EVM key is created/held HERE
 * and never crosses to the parent — only signatures + the address do (the
 * webauthn-prf-wallet / 1Shot isolation pattern). WebAuthn runs from in-frame
 * buttons so the ceremony keeps this frame's user activation.
 *
 * Three key-holding modes, chosen at registration by what the authenticator
 * supports (so it works whether or not PRF is available):
 *   - credBlob  : a random 32-byte key stored IN the credential at create; read
 *                 back every auth. One step. (security keys, some platforms)
 *   - largeBlob : a random key written to the credential's large blob via a
 *                 follow-up auth; read after. Two steps. (Apple iCloud Keychain)
 *   - prf       : key DERIVED from the authenticator's PRF output. (Android/modern)
 * PRF is preferred when available; otherwise LongBlob. Signing has no passkey
 * prompt, so it's driven by the parent over the Postmate RPC.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { startRegistration, startAuthentication } from "@simplewebauthn/browser";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { prfToValidEthPrivKey, bufToHex } from "@/lib/passkey/derive";
import { ETH_KEY_DERIVATION_LABEL } from "@/lib/passkey/config";

// Mirrors lib/passkey/store's CredentialMode (defined locally so this client
// iframe never imports the server-only store module).
type CredentialMode = "prf" | "credBlob" | "largeBlob";

const RPC_CALLBACK = "rpc:callback";
const WALLET_EVENT = "wallet:event";

function ser(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? { __t: "bigint", v: v.toString() } : v));
}
function deser<T>(s: string): T {
  return JSON.parse(s, (_k, v) => (v && typeof v === "object" && v.__t === "bigint" ? BigInt(v.v) : v)) as T;
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function toArrayBuffer(v: unknown): ArrayBuffer | null {
  if (v instanceof ArrayBuffer) return v;
  if (ArrayBuffer.isView(v)) {
    const view = v as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice().buffer;
  }
  if (Array.isArray(v)) {
    const out = new Uint8Array(v.length);
    for (let i = 0; i < v.length; i++) {
      const n = v[i];
      if (typeof n !== "number" || n < 0 || n > 255) return null;
      out[i] = n;
    }
    return out.buffer;
  }
  return null;
}
/** Read a 32-byte key blob (credBlob / largeBlob / PRF output) → 0x private key. */
function blobToKey(v: unknown): `0x${string}` | null {
  const ab = toArrayBuffer(v);
  if (!ab || ab.byteLength < 32) return null;
  return `0x${bufToHex(ab.byteLength === 32 ? ab : ab.slice(0, 32))}` as `0x${string}`;
}

export default function WalletIframePage() {
  const accountRef = useRef<PrivateKeyAccount | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const modelRef = useRef<any>(null);
  const infoLabelRef = useRef<Uint8Array>(new TextEncoder().encode(ETH_KEY_DERIVATION_LABEL));

  const [status, setStatus] = useState("");
  const [address, setAddress] = useState<`0x${string}` | null>(null);
  const [busy, setBusy] = useState(false);

  const emit = (data: unknown) => modelRef.current?.emit(WALLET_EVENT, ser(data));

  // Persist the credential + (LongBlob) address/mode server-side.
  const verifyRegister = (credential: unknown, challengeId: string, mode: CredentialMode, addr: `0x${string}` | null) =>
    fetch("/api/passkey/register/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential, challengeId, mode, address: addr }),
    });
  const verifyAuth = (credential: unknown, challengeId: string, addr: `0x${string}`) =>
    fetch("/api/passkey/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential, challengeId, address: addr }),
    });

  const setUnlocked = (account: PrivateKeyAccount) => {
    accountRef.current = account;
    setAddress(account.address);
    setStatus("unlocked");
    emit({ type: "unlocked", address: account.address });
  };

  const doCreate = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setStatus("creating passkey…");
    try {
      const optRes = await fetch("/api/passkey/register/options", { method: "POST" });
      if (!optRes.ok) throw new Error("couldn't get registration options");
      const options = await optRes.json();

      // A random key for the LongBlob paths (discarded if we end up in PRF mode).
      const randomKey = generatePrivateKey();
      const keyBytes = hexToBytes(randomKey);

      // Request ALL paths; the authenticator enables whichever it supports.
      options.extensions = {
        ...(options.extensions ?? {}),
        prf: { eval: { first: infoLabelRef.current } },
        credBlob: keyBytes,
        largeBlob: { support: "preferred" },
      };
      const credential = await startRegistration({ optionsJSON: options });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cer = (credential.clientExtensionResults as any) ?? {};
      const prfEnabled = cer?.prf?.enabled === true;
      const credBlobWritten = cer?.credBlob === true;
      const largeBlobSupported = cer?.largeBlob?.supported === true;

      // Prefer LongBlob (multi-passkey + simpler); PRF otherwise.
      let mode: CredentialMode;
      if (credBlobWritten) mode = "credBlob";
      else if (largeBlobSupported) mode = "largeBlob";
      else if (prfEnabled) mode = "prf";
      else throw new Error(`authenticator supports neither PRF nor credBlob/largeBlob · cer=${JSON.stringify(cer)}`);

      const longBlobAccount = mode === "prf" ? null : privateKeyToAccount(randomKey);
      const r = await verifyRegister(credential, options.challengeId, mode, longBlobAccount?.address ?? null);
      if (!r.ok) throw new Error("registration verification failed");
      setStatus(`passkey created · mode=${mode}`);
      emit({ type: "registered", credentialId: credential.id, prfEnabled, mode });

      // Finalize so the wallet is immediately usable.
      if (mode === "credBlob") {
        setUnlocked(longBlobAccount!); // key already lives in the credBlob
      } else if (mode === "largeBlob") {
        await writeLargeBlob(keyBytes, longBlobAccount!); // write the key, then ready
      } else {
        await readUnlock(); // PRF: derive now via an auth ceremony
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setStatus(`create failed: ${message}`);
      emit({ type: "error", phase: "register", message });
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);

  // largeBlob is write-once: store the key in the blob via an auth ceremony.
  async function writeLargeBlob(keyBytes: Uint8Array, account: PrivateKeyAccount) {
    const optRes = await fetch("/api/passkey/auth/options", { method: "POST" });
    if (!optRes.ok) throw new Error("couldn't get auth options (largeBlob write)");
    const options = await optRes.json();
    options.extensions = { ...(options.extensions ?? {}), largeBlob: { write: keyBytes } };
    const credential = await startAuthentication({ optionsJSON: options });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const written = (credential.clientExtensionResults as any)?.largeBlob?.written === true;
    if (!written) throw new Error("largeBlob write failed — the authenticator didn't store the key");
    const v = await verifyAuth(credential, options.challengeId, account.address);
    if (!v.ok) throw new Error("authentication verification failed");
    setUnlocked(account);
  }

  // Read/derive the key from whatever the credential holds (PRF / credBlob / largeBlob).
  const readUnlock = useCallback(async () => {
    const optRes = await fetch("/api/passkey/auth/options", { method: "POST" });
    if (!optRes.ok) throw new Error("couldn't get authentication options");
    const options = await optRes.json();
    options.extensions = {
      ...(options.extensions ?? {}),
      prf: { eval: { first: infoLabelRef.current } },
      getCredBlob: true,
      largeBlob: { read: true },
    };
    const credential = await startAuthentication({ optionsJSON: options });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cer = (credential.clientExtensionResults as any) ?? {};

    let key: `0x${string}` | null = null;
    const prfFirst = cer?.prf?.results?.first;
    if (prfFirst) {
      const ab = toArrayBuffer(prfFirst);
      if (ab) key = await prfToValidEthPrivKey(ab, infoLabelRef.current);
    }
    if (!key && cer?.credBlob) key = blobToKey(cer.credBlob);
    if (!key && cer?.largeBlob?.blob) key = blobToKey(cer.largeBlob.blob);
    if (!key) throw new Error(`no key material returned · cer=${JSON.stringify(cer)}`);

    const account = privateKeyToAccount(key);
    const v = await verifyAuth(credential, options.challengeId, account.address);
    if (!v.ok) throw new Error("authentication verification failed");
    setUnlocked(account);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doUnlock = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setStatus("unlocking…");
    try {
      await readUnlock();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setStatus(`unlock failed: ${message}`);
      emit({ type: "error", phase: "unlock", message });
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, readUnlock]);

  // Postmate Model for SIGNING (no passkey prompt → safe over RPC).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { default: Postmate } = await import("postmate");
      const requireAccount = (): PrivateKeyAccount => {
        if (!accountRef.current) throw new Error("wallet locked — unlock the passkey first");
        return accountRef.current;
      };
      async function rpc<TP, TR>(paramString: string, handler: (p: TP) => Promise<TR>): Promise<void> {
        let callbackNonce = -1;
        try {
          const env = deser<{ callbackNonce: number; params: TP }>(paramString);
          callbackNonce = env.callbackNonce;
          const result = await handler(env.params);
          modelRef.current?.emit(RPC_CALLBACK, ser({ success: true, callbackNonce, result: ser(result ?? null) }));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          modelRef.current?.emit(RPC_CALLBACK, ser({ success: false, callbackNonce, result: ser({ message }) }));
        }
      }
      const model = new Postmate.Model({
        getAddress: (p: string) => rpc(p, async () => ({ address: accountRef.current?.address ?? null })),
        signMessage: (p: string) =>
          rpc<{ message: string | { raw: `0x${string}` } }, { signature: `0x${string}` }>(p, async ({ message }) => ({
            signature: await requireAccount().signMessage({ message }),
          })),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        signTypedData: (p: string) => rpc<any, { signature: `0x${string}` }>(p, async (typedData) => ({
          signature: await requireAccount().signTypedData(typedData),
        })),
        signAuthorization: (p: string) =>
          rpc<{ contractAddress: `0x${string}`; chainId: number; nonce: number }, unknown>(p, async ({ contractAddress, chainId, nonce }) => {
            const sig = await requireAccount().signAuthorization({ address: contractAddress, chainId, nonce });
            return { chainId: sig.chainId, address: sig.address, nonce: sig.nonce, r: sig.r, s: sig.s, yParity: sig.yParity };
          }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        signTransaction: (p: string) => rpc<any, { signedTransaction: `0x${string}` }>(p, async (tx) => ({
          signedTransaction: await requireAccount().signTransaction(tx),
        })),
      });
      model.then((m) => {
        if (cancelled) return;
        modelRef.current = m;
        setStatus((s) => s || "ready");
      });
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div style={{ fontFamily: "system-ui", fontSize: 13, padding: 10, color: "#cfe", background: "#0b0f14", height: "100vh", boxSizing: "border-box" }}>
      <div style={{ fontWeight: 600, marginBottom: 8 }}>Conduit passkey wallet</div>
      {address ? (
        <div style={{ fontFamily: "monospace", fontSize: 12 }}>🔓 {address.slice(0, 10)}…{address.slice(-6)}</div>
      ) : (
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={doCreate} disabled={busy} style={btn}>Create wallet</button>
          <button onClick={doUnlock} disabled={busy} style={btn}>Unlock</button>
        </div>
      )}
      <div style={{ marginTop: 8, fontSize: 11, color: "#8aa", minHeight: 14 }}>{status}</div>
    </div>
  );
}

const btn: React.CSSProperties = {
  padding: "6px 10px",
  borderRadius: 6,
  border: "1px solid #345",
  background: "#11161c",
  color: "#cfe",
  fontSize: 12,
  cursor: "pointer",
};

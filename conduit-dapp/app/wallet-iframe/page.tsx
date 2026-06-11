"use client";
/**
 * The ISOLATED passkey wallet iframe (Conduit). The passkey-derived EVM key is
 * created and held HERE, in this frame's closure, and never crosses to the
 * parent — only signatures and the public address do (the webauthn-prf-wallet /
 * 1Shot isolation pattern).
 *
 * WebAuthn (register/unlock) is triggered by buttons RENDERED IN THIS FRAME, so
 * the ceremony always has this frame's transient user activation — the reliable
 * fix for the cross-frame "NotAllowedError / no prompt" gotcha. The parent learns
 * the result via emitted `wallet:event`s. SIGNING (no passkey prompt, so no
 * activation needed) is driven by the parent over the Postmate RPC.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { startRegistration, startAuthentication } from "@simplewebauthn/browser";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { prfToValidEthPrivKey } from "@/lib/passkey/derive";
import { ETH_KEY_DERIVATION_LABEL } from "@/lib/passkey/config";

const RPC_CALLBACK = "rpc:callback";
const WALLET_EVENT = "wallet:event";

function ser(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? { __t: "bigint", v: v.toString() } : v));
}
function deser<T>(s: string): T {
  return JSON.parse(s, (_k, v) => (v && typeof v === "object" && v.__t === "bigint" ? BigInt(v.v) : v)) as T;
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
function normalizePrfOutput(prfOutput: unknown): ArrayBuffer | null {
  if (prfOutput instanceof ArrayBuffer) return prfOutput;
  if (ArrayBuffer.isView(prfOutput)) {
    const v = prfOutput as ArrayBufferView;
    return bytesToArrayBuffer(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
  }
  if (Array.isArray(prfOutput)) {
    const out = new Uint8Array(prfOutput.length);
    for (let i = 0; i < prfOutput.length; i++) {
      const n = prfOutput[i];
      if (typeof n !== "number" || n < 0 || n > 255) return null;
      out[i] = n;
    }
    return bytesToArrayBuffer(out);
  }
  return null;
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

  const doRegister = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setStatus("creating passkey…");
    try {
      const optRes = await fetch("/api/passkey/register/options", { method: "POST" });
      if (!optRes.ok) throw new Error("couldn't get registration options");
      const options = await optRes.json();
      options.extensions = { ...(options.extensions ?? {}), prf: { eval: { first: infoLabelRef.current } } };
      const credential = await startRegistration({ optionsJSON: options });
      const verifyRes = await fetch("/api/passkey/register/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential, challengeId: options.challengeId }),
      });
      if (!verifyRes.ok) throw new Error("registration verification failed");
      setStatus("passkey created — now unlock");
      emit({ type: "registered", credentialId: credential.id });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setStatus(`register failed: ${message}`);
      emit({ type: "error", phase: "register", message });
    } finally {
      setBusy(false);
    }
  }, [busy]);

  const doUnlock = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setStatus("unlocking…");
    try {
      const optRes = await fetch("/api/passkey/auth/options", { method: "POST" });
      if (!optRes.ok) throw new Error("couldn't get authentication options");
      const options = await optRes.json();
      options.extensions = { ...(options.extensions ?? {}), prf: { eval: { first: infoLabelRef.current } } };
      const credential = await startAuthentication({ optionsJSON: options });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rawPrf = (credential.clientExtensionResults as any)?.prf?.results?.first;
      const prfOutput = normalizePrfOutput(rawPrf);
      if (!prfOutput) throw new Error("passkey returned no PRF output — use the provider you registered with");
      const privateKey = await prfToValidEthPrivKey(prfOutput, infoLabelRef.current);
      const account = privateKeyToAccount(privateKey);
      accountRef.current = account;
      const verifyRes = await fetch("/api/passkey/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential, challengeId: options.challengeId, address: account.address }),
      });
      if (!verifyRes.ok) throw new Error("authentication verification failed");
      setAddress(account.address);
      setStatus("unlocked");
      emit({ type: "unlocked", address: account.address });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setStatus(`unlock failed: ${message}`);
      emit({ type: "error", phase: "unlock", message });
    } finally {
      setBusy(false);
    }
  }, [busy]);

  // Set up the Postmate Model (SIGNING RPC + getAddress). Register/unlock are
  // driven by the in-frame buttons above, not the RPC, so they keep activation.
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
          <button onClick={doRegister} disabled={busy} style={btn}>Create wallet</button>
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

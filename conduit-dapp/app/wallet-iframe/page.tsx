"use client";
/**
 * The ISOLATED passkey wallet iframe (Conduit). This page is embedded by the
 * parent app in a same-origin iframe; the passkey-derived EVM key is created and
 * held HERE, in this frame's closure, and never crosses to the parent — only
 * signatures and the public address do (per the webauthn-prf-wallet skill, which
 * is the 1Shot Payments isolation pattern).
 *
 * It exposes a Postmate `Model` RPC surface: register / unlock / getAddress /
 * signMessage / signTypedData / signAuthorization / signTransaction. Each call
 * uses the skill's envelope (a `callbackNonce` echoed back over a single
 * `rpc:callback` emit), and params/results are bigint-safe-serialized so viem's
 * transaction objects survive the postMessage boundary.
 */
import { useEffect, useRef, useState } from "react";
import { startRegistration, startAuthentication } from "@simplewebauthn/browser";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { prfToValidEthPrivKey } from "@/lib/passkey/derive";
import { ETH_KEY_DERIVATION_LABEL } from "@/lib/passkey/config";

const RPC_CALLBACK = "rpc:callback";

// --- bigint-safe JSON (viem tx objects carry bigints across the RPC) ----------
function ser(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    typeof v === "bigint" ? { __t: "bigint", v: v.toString() } : v
  );
}
function deser<T>(s: string): T {
  return JSON.parse(s, (_k, v) =>
    v && typeof v === "object" && v.__t === "bigint" ? BigInt(v.v) : v
  ) as T;
}

// --- PRF output normalization (from the skill — providers return varied shapes) -
function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
function normalizePrfOutput(prfOutput: unknown): ArrayBuffer | null {
  if (prfOutput instanceof ArrayBuffer) return prfOutput;
  if (ArrayBuffer.isView(prfOutput)) {
    const view = prfOutput as ArrayBufferView;
    return bytesToArrayBuffer(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
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
  const ready = useRef(false);
  const [status, setStatus] = useState("initializing…");

  useEffect(() => {
    if (ready.current) return;
    ready.current = true;

    // The unlocked account lives ONLY in this closure — never exposed to the parent.
    let account: PrivateKeyAccount | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let model: any = null;
    const infoLabel = new TextEncoder().encode(ETH_KEY_DERIVATION_LABEL);

    const requireAccount = (): PrivateKeyAccount => {
      if (!account) throw new Error("wallet locked — unlock the passkey first");
      return account;
    };

    async function doRegister(): Promise<{ credentialId: string }> {
      const optRes = await fetch("/api/passkey/register/options", { method: "POST" });
      if (!optRes.ok) throw new Error("couldn't get registration options");
      const options = await optRes.json();
      // Enable PRF on the new credential with the eval input as RAW BYTES — the
      // browser's create() rejects a base64url string here (it wants an
      // ArrayBuffer/View), and @simplewebauthn doesn't convert PRF values.
      options.extensions = {
        ...(options.extensions ?? {}),
        prf: { eval: { first: infoLabel } },
      };
      const credential = await startRegistration({ optionsJSON: options });
      const verifyRes = await fetch("/api/passkey/register/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential, challengeId: options.challengeId }),
      });
      if (!verifyRes.ok) throw new Error("registration verification failed");
      return { credentialId: credential.id };
    }

    async function doUnlock(): Promise<{ address: `0x${string}` }> {
      const optRes = await fetch("/api/passkey/auth/options", { method: "POST" });
      if (!optRes.ok) throw new Error("couldn't get authentication options");
      const options = await optRes.json();
      // Inject the PRF eval input client-side as RAW BYTES (the deterministic
      // salt). Same input + same credential ⇒ same PRF output ⇒ same wallet.
      options.extensions = {
        ...(options.extensions ?? {}),
        prf: { eval: { first: infoLabel } },
      };
      const credential = await startAuthentication({ optionsJSON: options });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rawPrf = (credential.clientExtensionResults as any)?.prf?.results?.first;
      const prfOutput = normalizePrfOutput(rawPrf);
      if (!prfOutput) {
        throw new Error("passkey returned no PRF output — use the provider you registered with");
      }
      const privateKey = await prfToValidEthPrivKey(prfOutput, infoLabel);
      account = privateKeyToAccount(privateKey);
      const verifyRes = await fetch("/api/passkey/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential, challengeId: options.challengeId, address: account.address }),
      });
      if (!verifyRes.ok) throw new Error("authentication verification failed");
      return { address: account.address };
    }

    // RPC envelope: run `handler(params)`, reply via a single `rpc:callback` emit.
    async function rpc<TParams, TReturn>(
      paramString: string,
      handler: (params: TParams) => Promise<TReturn>
    ): Promise<void> {
      let callbackNonce = -1;
      try {
        const env = deser<{ callbackNonce: number; params: TParams }>(paramString);
        callbackNonce = env.callbackNonce;
        const result = await handler(env.params);
        model?.emit(RPC_CALLBACK, ser({ success: true, callbackNonce, result: ser(result ?? null) }));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        model?.emit(RPC_CALLBACK, ser({ success: false, callbackNonce, result: ser({ message }) }));
      }
    }

    void (async () => {
    const { default: Postmate } = await import("postmate");
    const handshake = new Postmate.Model({
      register: (p: string) => rpc(p, () => doRegister()),
      unlock: (p: string) => rpc(p, () => doUnlock()),
      getAddress: (p: string) => rpc(p, async () => ({ address: account?.address ?? null })),
      signMessage: (p: string) =>
        rpc<{ message: string | { raw: `0x${string}` } }, { signature: `0x${string}` }>(p, async ({ message }) => ({
          signature: await requireAccount().signMessage({ message }),
        })),
      signTypedData: (p: string) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        rpc<any, { signature: `0x${string}` }>(p, async (typedData) => ({
          signature: await requireAccount().signTypedData(typedData),
        })),
      signAuthorization: (p: string) =>
        rpc<{ contractAddress: `0x${string}`; chainId: number; nonce: number }, unknown>(p, async ({ contractAddress, chainId, nonce }) => {
          const sig = await requireAccount().signAuthorization({ address: contractAddress, chainId, nonce });
          // Shape it as the app's Eip7702Authorization (chainId, address, nonce, r, s, yParity).
          return { chainId: sig.chainId, address: sig.address, nonce: sig.nonce, r: sig.r, s: sig.s, yParity: sig.yParity };
        }),
      signTransaction: (p: string) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        rpc<any, { signedTransaction: `0x${string}` }>(p, async (tx) => ({
          signedTransaction: await requireAccount().signTransaction(tx),
        })),
    });

    handshake.then((m) => {
      model = m;
      setStatus("ready");
    });
    })();
  }, []);

  return (
    <div style={{ fontFamily: "monospace", fontSize: 12, padding: 8, color: "#9aa" }}>
      Conduit passkey wallet · {status}
    </div>
  );
}

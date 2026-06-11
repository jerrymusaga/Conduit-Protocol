/**
 * Parent-side adapter for the isolated passkey wallet (Conduit). Embeds the
 * /wallet-iframe page, does the Postmate handshake, and proxies signing to it —
 * the private key never enters this (the parent) context. Exposes the same
 * surface the rest of the dapp needs:
 *   - register() / unlock()  → create or open a passkey wallet, returns the address
 *   - getWalletClient()      → a viem WalletClient whose signMessage/signTypedData/
 *                              signTransaction proxy to the iframe
 *   - signAuthorization()    → an EIP-7702 authorization (matches Privy's hook shape)
 *
 * Client-only (touches window/document). Mirrors the webauthn-prf-wallet skill's
 * parent `WalletProxy` (the 1Shot Payments pattern) with a bigint-safe envelope.
 */
import { createWalletClient, http, type WalletClient } from "viem";
import { toAccount } from "viem/accounts";
import { activeChain } from "@/lib/chain";
import type { Eip7702Authorization } from "@/lib/payment";

const RPC_CALLBACK = "rpc:callback";
const IFRAME_URL = "/wallet-iframe";

// bigint-safe JSON, matching the iframe side.
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

type Resolver = { resolve: (v: unknown) => void; reject: (e: Error) => void };

class PasskeyWallet {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private child: any = null;
  private initPromise: Promise<void> | null = null;
  private rpcNonce = 0;
  private callbacks = new Map<number, Resolver>();
  private _address: `0x${string}` | null = null;

  get address(): `0x${string}` | null {
    return this._address;
  }

  /** Embed the iframe + handshake (idempotent). */
  async init(): Promise<void> {
    if (this.child) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      const { default: Postmate } = await import("postmate");

      // A small, VISIBLE container — WebAuthn won't prompt from a display:none or
      // zero-size frame, so park it unobtrusively rather than hiding it.
      const container = document.createElement("div");
      container.style.cssText =
        "position:fixed;right:8px;bottom:8px;width:220px;height:34px;z-index:2147483647;border-radius:8px;overflow:hidden;opacity:0.6;";
      container.setAttribute("aria-hidden", "true");
      document.body.appendChild(container);

      const handshake = new Postmate({ container, url: IFRAME_URL, name: "conduit-wallet-iframe", classListArray: [] });
      const child = await handshake;
      child.frame.setAttribute("allow", "publickey-credentials-get *; publickey-credentials-create *");

      child.on(RPC_CALLBACK, (payload: string) => {
        let parsed: { success: boolean; callbackNonce: number; result: string };
        try {
          parsed = deser(payload);
        } catch {
          return;
        }
        const cb = this.callbacks.get(parsed.callbackNonce);
        if (!cb) return;
        this.callbacks.delete(parsed.callbackNonce);
        const result = deser<unknown>(parsed.result);
        if (parsed.success) cb.resolve(result);
        else cb.reject(new Error((result as { message?: string })?.message ?? "passkey wallet error"));
      });

      this.child = child;
    })();
    return this.initPromise;
  }

  /**
   * Dispatch an RPC. CRITICAL for WebAuthn: this must run SYNCHRONOUSLY inside the
   * click handler (no awaited init before the `child.call`), or the user's
   * transient activation is lost and `navigator.credentials.get()` in the iframe
   * throws NotAllowedError. We also focus the iframe's contentWindow then the
   * frame, which is what carries activation across the postMessage boundary.
   */
  private rpcCall<T>(method: string, params: unknown): Promise<T> {
    if (!this.child) {
      return Promise.reject(new Error("passkey wallet not ready — call init() first"));
    }
    const frame = this.child.frame as HTMLIFrameElement;
    frame.contentWindow?.focus();
    frame.focus();
    return new Promise<T>((resolve, reject) => {
      const callbackNonce = this.rpcNonce++;
      this.callbacks.set(callbackNonce, { resolve: resolve as (v: unknown) => void, reject });
      this.child.call(method, ser({ callbackNonce, params }));
    });
  }

  /** Create a brand-new passkey wallet (registration ceremony). */
  async register(): Promise<{ credentialId: string }> {
    return this.rpcCall<{ credentialId: string }>("register", {});
  }

  /** Open an existing passkey wallet (auth ceremony → derives the key). */
  async unlock(): Promise<`0x${string}`> {
    const { address } = await this.rpcCall<{ address: `0x${string}` }>("unlock", {});
    this._address = address;
    return address;
  }

  /** A viem WalletClient backed by the iframe-held key. */
  getWalletClient(): WalletClient {
    if (!this._address) throw new Error("passkey wallet locked — unlock first");
    const account = toAccount({
      address: this._address,
      signMessage: async ({ message }) =>
        (await this.rpcCall<{ signature: `0x${string}` }>("signMessage", { message })).signature,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      signTypedData: async (typedData: any) =>
        (await this.rpcCall<{ signature: `0x${string}` }>("signTypedData", typedData)).signature,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      signTransaction: async (transaction: any) =>
        (await this.rpcCall<{ signedTransaction: `0x${string}` }>("signTransaction", transaction)).signedTransaction,
    });
    return createWalletClient({ account, chain: activeChain, transport: http() });
  }

  /** Sign an EIP-7702 authorization (same shape as Privy's useSign7702Authorization). */
  async signAuthorization(params: {
    contractAddress: `0x${string}`;
    chainId: number;
    nonce: number;
  }): Promise<Eip7702Authorization> {
    return this.rpcCall<Eip7702Authorization>("signAuthorization", params);
  }
}

let _wallet: PasskeyWallet | null = null;
export function getPasskeyWallet(): PasskeyWallet {
  if (!_wallet) _wallet = new PasskeyWallet();
  return _wallet;
}
export type { PasskeyWallet };

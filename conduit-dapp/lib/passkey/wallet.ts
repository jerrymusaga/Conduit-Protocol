/**
 * Parent-side adapter for the isolated passkey wallet (Conduit). Embeds the
 * /wallet-iframe page, listens for its `wallet:event`s (register/unlock happen
 * via buttons INSIDE the iframe — so the WebAuthn ceremony keeps that frame's
 * user activation), and proxies SIGNING to it over Postmate RPC. The private key
 * never enters this (the parent) context.
 *
 * Exposes the surface the dapp needs:
 *   - onEvent()           → register/unlock/error notifications from the iframe
 *   - address             → set once the iframe reports it's unlocked
 *   - getWalletClient()   → a viem WalletClient whose signing proxies to the iframe
 *   - signAuthorization() → an EIP-7702 authorization (matches Privy's hook shape)
 */
import { createWalletClient, http, type WalletClient } from "viem";
import { toAccount } from "viem/accounts";
import { activeChain } from "@/lib/chain";
import type { Eip7702Authorization } from "@/lib/payment";

const RPC_CALLBACK = "rpc:callback";
const WALLET_EVENT = "wallet:event";
const IFRAME_URL = "/wallet-iframe";

function ser(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? { __t: "bigint", v: v.toString() } : v));
}
function deser<T>(s: string): T {
  return JSON.parse(s, (_k, v) => (v && typeof v === "object" && v.__t === "bigint" ? BigInt(v.v) : v)) as T;
}

export type WalletEvent =
  | { type: "registered"; credentialId: string; prfEnabled?: boolean; mode?: "prf" | "credBlob" | "largeBlob" }
  | { type: "unlocked"; address: `0x${string}` }
  | { type: "error"; phase: "register" | "unlock"; message: string };

type Resolver = { resolve: (v: unknown) => void; reject: (e: Error) => void };

class PasskeyWallet {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private child: any = null;
  private initPromise: Promise<void> | null = null;
  private rpcNonce = 0;
  private callbacks = new Map<number, Resolver>();
  private listeners = new Set<(e: WalletEvent) => void>();
  private _address: `0x${string}` | null = null;

  get address(): `0x${string}` | null {
    return this._address;
  }

  /** Subscribe to register/unlock/error events from the iframe. Returns an unsub. */
  onEvent(cb: (e: WalletEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Embed the iframe + handshake (idempotent). Call once on mount. */
  async init(): Promise<void> {
    if (this.child) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      const { default: Postmate } = await import("postmate");

      // VISIBLE + interactive — the user clicks Create/Unlock INSIDE this frame so
      // the WebAuthn ceremony has the frame's activation. Parked bottom-right.
      const container = document.createElement("div");
      container.style.cssText =
        "position:fixed;right:12px;bottom:12px;width:320px;height:120px;z-index:2147483647;border-radius:10px;overflow:hidden;box-shadow:0 6px 24px rgba(0,0,0,.4);";
      document.body.appendChild(container);

      const handshake = new Postmate({ container, url: IFRAME_URL, name: "conduit-wallet-iframe", classListArray: [] });
      const child = await handshake;
      child.frame.setAttribute("allow", "publickey-credentials-get *; publickey-credentials-create *");
      child.frame.style.cssText = "width:100%;height:100%;border:0;";

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

      child.on(WALLET_EVENT, (payload: string) => {
        let evt: WalletEvent;
        try {
          evt = deser<WalletEvent>(payload);
        } catch {
          return;
        }
        if (evt.type === "unlocked") this._address = evt.address;
        this.listeners.forEach((l) => l(evt));
      });

      this.child = child;
    })();
    return this.initPromise;
  }

  private rpcCall<T>(method: string, params: unknown): Promise<T> {
    if (!this.child) {
      return Promise.reject(new Error("passkey wallet not ready — call init() first"));
    }
    return new Promise<T>((resolve, reject) => {
      const callbackNonce = this.rpcNonce++;
      this.callbacks.set(callbackNonce, { resolve: resolve as (v: unknown) => void, reject });
      this.child.call(method, ser({ callbackNonce, params }));
    });
  }

  /** A viem WalletClient backed by the iframe-held key (signing has no passkey
   *  prompt, so it's safe to drive over the RPC). */
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

"use client";
/**
 * Standalone proving ground for the passkey (WebAuthn PRF) wallet — NOT wired
 * into the demo. Create/unlock happen in the wallet frame (bottom-right) so the
 * WebAuthn ceremony keeps that frame's activation; this page listens for the
 * result and then exercises SIGNING (EIP-712 + EIP-7702), driven over the RPC.
 */
import { useEffect, useState } from "react";
import { getPasskeyWallet } from "@/lib/passkey/wallet";
import { config } from "@/lib/config";

export default function WalletTestPage() {
  const [log, setLog] = useState<string[]>([]);
  const [address, setAddress] = useState<`0x${string}` | null>(null);
  const [busy, setBusy] = useState(false);
  const wallet = getPasskeyWallet();

  const add = (line: string) => setLog((l) => [...l, `${new Date().toLocaleTimeString()} · ${line}`]);

  // Init the iframe + subscribe to its register/unlock/error events.
  useEffect(() => {
    void wallet.init();
    const off = wallet.onEvent((e) => {
      if (e.type === "registered") add(`✓ registered · mode=${e.mode} · PRF ${e.prfEnabled ? "✓" : "✗"}`);
      else if (e.type === "unlocked") { setAddress(e.address); add(`✓ unlocked · ${e.address}`); }
      else add(`✗ ${e.phase} failed · ${e.message}`);
    });
    return off;
  }, [wallet]);

  const run = async (label: string, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    add(`▶ ${label}…`);
    try {
      await fn();
    } catch (e) {
      add(`✗ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main style={{ maxWidth: 760, margin: "40px auto", padding: 24, fontFamily: "system-ui" }}>
      <h1 style={{ fontSize: 20, fontWeight: 700 }}>Passkey wallet — isolated test</h1>
      <p style={{ color: "#667", fontSize: 13, marginTop: 4 }}>
        WebAuthn PRF → secp256k1, key held in the <code>/wallet-iframe</code> frame. Use the
        <strong> wallet frame (bottom-right)</strong> to <em>Create</em> then <em>Unlock</em> — the ceremony
        runs there so it keeps activation. Then sign below. Needs a platform passkey (Touch ID etc.).
      </p>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 16 }}>
        <button disabled={busy || !address} onClick={() => run("Sign EIP-712 typed data", async () => {
          const client = wallet.getWalletClient();
          const signature = await client.signTypedData({
            account: client.account!,
            domain: { name: "Conduit", version: "1", chainId: config.chainId },
            types: { Test: [{ name: "msg", type: "string" }, { name: "at", type: "uint256" }] },
            primaryType: "Test",
            message: { msg: "passkey wallet works", at: BigInt(Date.now()) },
          });
          add(`✓ EIP-712 signature ${signature.slice(0, 22)}…`);
        })} style={btn}>Sign typed data</button>

        <button disabled={busy || !address} onClick={() => run("Sign EIP-7702 authorization", async () => {
          const auth = await wallet.signAuthorization({
            contractAddress: config.eip7702Impl as `0x${string}`,
            chainId: config.chainId,
            nonce: 0,
          });
          add(`✓ 7702 auth · addr ${auth.address.slice(0, 10)}… yParity ${auth.yParity} r ${auth.r.slice(0, 10)}…`);
        })} style={btn}>Sign 7702 auth</button>
      </div>

      {address && (
        <p style={{ marginTop: 14, fontFamily: "monospace", fontSize: 13 }}>
          wallet: <strong>{address}</strong>
        </p>
      )}

      <pre style={{ marginTop: 16, background: "#0b0f14", color: "#cfe", padding: 14, borderRadius: 8, fontSize: 12, minHeight: 160, whiteSpace: "pre-wrap" }}>
        {log.join("\n") || "use the wallet frame (bottom-right) to create + unlock, then sign here…"}
      </pre>
    </main>
  );
}

const btn: React.CSSProperties = {
  padding: "8px 12px",
  borderRadius: 8,
  border: "1px solid #345",
  background: "#11161c",
  color: "#cfe",
  fontSize: 13,
  cursor: "pointer",
};

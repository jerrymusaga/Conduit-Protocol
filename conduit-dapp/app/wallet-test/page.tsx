"use client";
/**
 * Standalone proving ground for the passkey (WebAuthn PRF) wallet — NOT wired
 * into the demo. It exercises the full isolated path so we can verify the wallet
 * works before integrating it as a connect option:
 *   register → unlock (derives the key in the iframe) → sign EIP-712 typed data →
 *   sign an EIP-7702 authorization (the two signatures Conduit actually needs).
 *
 * The key is held in the /wallet-iframe frame and never reaches this page.
 */
import { useState } from "react";
import { getPasskeyWallet } from "@/lib/passkey/wallet";
import { config } from "@/lib/config";

export default function WalletTestPage() {
  const [log, setLog] = useState<string[]>([]);
  const [address, setAddress] = useState<`0x${string}` | null>(null);
  const [busy, setBusy] = useState(false);
  const wallet = getPasskeyWallet();

  const add = (line: string) => setLog((l) => [...l, `${new Date().toLocaleTimeString()} · ${line}`]);
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
        WebAuthn PRF → secp256k1, key held in the <code>/wallet-iframe</code> frame. Proves the wallet
        signs EIP-712 + EIP-7702 before we wire it into the demo. Needs a platform passkey (Touch ID etc.).
      </p>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 16 }}>
        <button disabled={busy} onClick={() => run("Register new passkey", async () => {
          const { credentialId } = await wallet.register();
          add(`✓ registered · credential ${credentialId.slice(0, 12)}…`);
        })} style={btn}>1 · Register passkey</button>

        <button disabled={busy} onClick={() => run("Unlock wallet", async () => {
          const addr = await wallet.unlock();
          setAddress(addr);
          add(`✓ unlocked · address ${addr}`);
        })} style={btn}>2 · Unlock</button>

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
        })} style={btn}>3 · Sign typed data</button>

        <button disabled={busy || !address} onClick={() => run("Sign EIP-7702 authorization", async () => {
          const auth = await wallet.signAuthorization({
            contractAddress: config.eip7702Impl as `0x${string}`,
            chainId: config.chainId,
            nonce: 0,
          });
          add(`✓ 7702 auth · addr ${auth.address.slice(0, 10)}… yParity ${auth.yParity} r ${auth.r.slice(0, 10)}…`);
        })} style={btn}>4 · Sign 7702 auth</button>
      </div>

      {address && (
        <p style={{ marginTop: 14, fontFamily: "monospace", fontSize: 13 }}>
          wallet: <strong>{address}</strong>
        </p>
      )}

      <pre style={{ marginTop: 16, background: "#0b0f14", color: "#cfe", padding: 14, borderRadius: 8, fontSize: 12, minHeight: 160, whiteSpace: "pre-wrap" }}>
        {log.join("\n") || "logs will appear here…"}
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

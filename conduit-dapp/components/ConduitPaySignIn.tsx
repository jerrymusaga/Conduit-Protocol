"use client";
/**
 * ConduitPay sign-in gate. You can't enter the app without signing in — with a
 * Passkey (the isolated WebAuthn-PRF embedded wallet) or with Privy (email /
 * MetaMask / injected). Privy is the default, universal path; passkey is the
 * non-custodial showcase (works on Chrome/Android + PRF security keys + macOS 15).
 */
import { useEffect, useState } from "react";
import { useLogin } from "@privy-io/react-auth";
import { useActiveWallet } from "@/lib/activeWallet";

export function ConduitPaySignIn() {
  const { setProvider, passkeyWallet } = useActiveWallet();
  const { login } = useLogin();
  const [mode, setMode] = useState<"choose" | "passkey">("choose");
  const [note, setNote] = useState<string>("");

  // When the user picks passkey, mount the wallet iframe + surface its events.
  useEffect(() => {
    if (mode !== "passkey") return;
    setProvider("passkey");
    void passkeyWallet.init();
    const off = passkeyWallet.onEvent((e) => {
      if (e.type === "registered") setNote("Passkey created — now tap Unlock in the wallet panel.");
      else if (e.type === "unlocked") setNote("Unlocked ✓");
      else if (e.type === "error") setNote(`${e.phase} failed · ${e.message}`);
    });
    return off;
  }, [mode, setProvider, passkeyWallet]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-conduit-bg px-6">
      <div className="panel reveal w-full max-w-md p-8">
        <div className="flex items-center gap-2">
          <span className="text-lg font-semibold tracking-tight text-white">ConduitPay</span>
          <span className="mono rounded bg-conduit-cyan/10 px-1.5 py-0.5 text-[10px] text-conduit-cyan">sign in</span>
        </div>
        <p className="mt-2 text-[13px] leading-relaxed text-conduit-muted">
          Pay AI agents within bounded, on-chain permissions you sign. Sign in to continue.
        </p>

        {mode === "choose" ? (
          <div className="mt-6 space-y-3">
            <button
              onClick={() => { setProvider("privy"); login(); }}
              className="w-full rounded-xl border border-conduit-cyan/40 bg-conduit-cyan/10 px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-conduit-cyan/15"
            >
              Continue with email or wallet
              <span className="mt-0.5 block text-[11px] font-normal text-conduit-muted">Email, MetaMask, or an injected wallet · works everywhere</span>
            </button>
            <button
              onClick={() => setMode("passkey")}
              className="w-full rounded-xl border border-conduit-border px-4 py-3 text-sm font-medium text-white transition-colors hover:border-conduit-violet/50"
            >
              Continue with a passkey
              <span className="mt-0.5 block text-[11px] font-normal text-conduit-muted">Non-custodial · Face/Touch ID · Chrome, Android, or a security key</span>
            </button>
          </div>
        ) : (
          <div className="mt-6 space-y-3">
            <div className="rounded-xl border border-conduit-violet/30 bg-conduit-violet/[0.06] px-4 py-3 text-[13px] text-conduit-muted">
              Use the <span className="text-white">wallet panel (bottom-right)</span> → <span className="text-white">Create wallet</span>, then <span className="text-white">Unlock</span>. Your key is derived from the passkey and held in an isolated iframe — it never touches this page.
            </div>
            {note && <div className="mono text-[12px] text-conduit-cyan">{note}</div>}
            <button onClick={() => setMode("choose")} className="text-[12px] text-conduit-muted hover:text-white">
              ← back
            </button>
          </div>
        )}

        <p className="mt-6 border-t border-conduit-border/60 pt-4 text-[11px] text-conduit-muted">
          Building with Conduit? See the <a href="/docs" className="text-conduit-cyan hover:underline">developer docs</a>.
        </p>
      </div>
    </main>
  );
}

"use client";
/**
 * ConduitPay sign-in gate. You can't enter the app without signing in — with a
 * Passkey (the isolated WebAuthn-PRF embedded wallet, shown INLINE here) or with
 * Privy (email / MetaMask / injected). Privy is the universal default; passkey is
 * the non-custodial showcase (Chrome/Android, PRF security keys, macOS 15+).
 */
import { useEffect, useRef, useState } from "react";
import { useLogin } from "@privy-io/react-auth";
import { useActiveWallet } from "@/lib/activeWallet";

export function ConduitPaySignIn() {
  const { setProvider, passkeyWallet } = useActiveWallet();
  const { login } = useLogin();
  const [mode, setMode] = useState<"choose" | "passkey">("choose");
  const [note, setNote] = useState<string>("");
  const frameRef = useRef<HTMLDivElement>(null);

  // Passkey mode → reveal the persistent wallet frame OVER the inline slot, and
  // keep it positioned there. It parks itself (stays mounted) once we leave.
  useEffect(() => {
    if (mode !== "passkey") return;
    setProvider("passkey");
    let active = true;
    const reposition = () => active && passkeyWallet.showAt(frameRef.current);
    void passkeyWallet.init().then(reposition);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    const off = passkeyWallet.onEvent((e) => {
      if (e.type === "registered") setNote("Passkey created — now tap Unlock.");
      else if (e.type === "unlocked") setNote("Unlocked ✓ — entering ConduitPay…");
      else if (e.type === "error") setNote(`${e.phase} failed · ${e.message}`);
    });
    return () => {
      active = false;
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
      passkeyWallet.showAt(null); // park the frame (keeps it mounted for signing)
      off();
    };
  }, [mode, setProvider, passkeyWallet]);

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-conduit-bg px-6">
      {/* ambient glows */}
      <div className="pointer-events-none absolute -top-40 left-1/2 h-[420px] w-[720px] -translate-x-1/2 rounded-full bg-conduit-cyan/10 blur-[120px]" />
      <div className="pointer-events-none absolute bottom-[-160px] right-[-80px] h-[360px] w-[360px] rounded-full bg-conduit-violet/10 blur-[120px]" />

      <div className="relative grid w-full max-w-4xl gap-10 md:grid-cols-2 md:items-center">
        {/* Left — brand + pitch */}
        <div className="hidden md:block">
          <div className="flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/images/conduit-logo.png" alt="Conduit" className="h-9 w-9 object-contain drop-shadow-[0_0_16px_rgba(0,229,255,0.4)]" />
            <span className="text-xl font-semibold tracking-tight text-white">ConduitPay</span>
          </div>
          <h1 className="mt-6 text-[28px] font-semibold leading-tight tracking-tight text-white">
            Pay AI agents<br />you don&apos;t have to trust.
          </h1>
          <p className="mt-4 max-w-sm text-[14px] leading-relaxed text-conduit-muted">
            Every payment is bounded by a permission you sign — exact amount, recipient, intent — enforced on-chain.
            A compromised agent still can&apos;t overspend, redirect, or pay anyone you didn&apos;t approve.
          </p>
          <ul className="mt-6 space-y-2.5">
            {["One signature, many agents, one transaction", "Gas paid in USDC via 1Shot", "Revoke any permission on-chain, anytime"].map((t) => (
              <li key={t} className="flex items-start gap-2.5 text-[13px] text-conduit-muted">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-conduit-cyan shadow-glow" />
                {t}
              </li>
            ))}
          </ul>
          <div className="mt-7">
            <p className="text-[11px] uppercase tracking-wide text-conduit-muted/60">Inside</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {["Pay", "Subscriptions", "Yield", "Portfolio"].map((p) => (
                <span key={p} className="rounded-md border border-conduit-border bg-white/[0.03] px-2.5 py-1 text-[12px] text-conduit-muted">{p}</span>
              ))}
            </div>
          </div>
        </div>

        {/* Right — sign-in card */}
        <div className="panel reveal w-full p-7">
          <div className="flex items-center gap-2 md:hidden">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/images/conduit-logo.png" alt="Conduit" className="h-7 w-7 object-contain" />
            <span className="text-lg font-semibold tracking-tight text-white">ConduitPay</span>
          </div>
          <h2 className="mt-1 text-lg font-semibold tracking-tight text-white md:mt-0">Sign in</h2>
          <p className="mt-1 text-[13px] text-conduit-muted">Choose how you want to hold your account.</p>

          {mode === "choose" ? (
            <div className="mt-6 space-y-3">
              <button
                onClick={() => { setProvider("privy"); login(); }}
                className="group flex w-full items-center gap-3 rounded-xl border border-conduit-cyan/40 bg-conduit-cyan/[0.07] px-4 py-3.5 text-left transition-colors hover:bg-conduit-cyan/[0.12]"
              >
                <span className="grid h-9 w-9 place-items-center rounded-lg bg-conduit-cyan/15 text-conduit-cyan">✉</span>
                <span>
                  <span className="block text-sm font-medium text-white">Email or wallet</span>
                  <span className="block text-[11px] text-conduit-muted">Email, MetaMask, or injected · works everywhere</span>
                </span>
              </button>
              <button
                onClick={() => setMode("passkey")}
                className="group flex w-full items-center gap-3 rounded-xl border border-conduit-border px-4 py-3.5 text-left transition-colors hover:border-conduit-violet/50"
              >
                <span className="grid h-9 w-9 place-items-center rounded-lg bg-conduit-violet/15 text-conduit-violet">🔑</span>
                <span>
                  <span className="block text-sm font-medium text-white">Passkey</span>
                  <span className="block text-[11px] text-conduit-muted">Non-custodial · Face/Touch ID · key never leaves an isolated frame</span>
                </span>
              </button>
            </div>
          ) : (
            <div className="mt-6 space-y-3">
              <div className="rounded-xl border border-conduit-violet/25 bg-conduit-violet/[0.05] px-3.5 py-2.5 text-[12px] leading-relaxed text-conduit-muted">
                First time? Tap <span className="text-white">Create wallet</span>. Coming back? Tap <span className="text-white">Unlock</span>.
                Your key is derived from your passkey and lives in an <span className="text-white">isolated frame</span> — it never touches this page or any server.
              </div>
              {/* the isolated wallet frame, positioned over this slot */}
              <div
                ref={frameRef}
                className="h-[124px] w-full overflow-hidden rounded-xl border border-conduit-violet/30 bg-black/30"
              />
              {note && <div className="mono text-[12px] text-conduit-cyan">{note}</div>}
              <p className="text-[11px] leading-relaxed text-conduit-muted/70">
                Works on Chrome, Android, or a hardware security key. On an unsupported device, use email or wallet instead.
              </p>
              <button onClick={() => setMode("choose")} className="text-[12px] text-conduit-muted transition-colors hover:text-white">
                ← other options
              </button>
            </div>
          )}

          <p className="mt-6 border-t border-conduit-border/60 pt-4 text-[11px] text-conduit-muted">
            Building with Conduit? See the <a href="/docs" className="text-conduit-cyan hover:underline">developer docs</a>.
          </p>
        </div>
      </div>
    </main>
  );
}

"use client";
/**
 * ConduitPay auth gate. You cannot reach the app without signing in (Passkey or
 * Privy). While Privy restores a session we show a brief loader; signed out → the
 * sign-in screen; signed in → the app shell wraps the active tab.
 */
import { usePrivy } from "@privy-io/react-auth";
import { useActiveWallet } from "@/lib/activeWallet";
import { ConduitPaySignIn } from "@/components/ConduitPaySignIn";
import { ConduitPayShell } from "@/components/ConduitPayShell";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { ready } = usePrivy();
  const { isConnected } = useActiveWallet();

  if (!ready) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-conduit-bg">
        <span className="mono text-sm text-conduit-muted">Loading ConduitPay…</span>
      </main>
    );
  }
  if (!isConnected) return <ConduitPaySignIn />;
  return <ConduitPayShell>{children}</ConduitPayShell>;
}

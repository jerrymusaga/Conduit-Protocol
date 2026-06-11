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
import { ConduitLogoLoader } from "@/components/ConduitLogoLoader";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { ready } = usePrivy();
  const { isConnected } = useActiveWallet();

  if (!ready) return <ConduitLogoLoader />;
  if (!isConnected) return <ConduitPaySignIn />;
  return <ConduitPayShell>{children}</ConduitPayShell>;
}

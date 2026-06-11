"use client";
/**
 * The ConduitPay app shell — persistent chrome once signed in: brand, tab nav
 * (Pay / Subscriptions / Portfolio), a tap-to-copy wallet chip, and sign out
 * (closes the gate → landing). Responsive: nav drops to a scrollable row on
 * mobile and the wallet chip stays visible + copyable on every size.
 */
import { useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { useActiveWallet } from "@/lib/activeWallet";
import { EmbeddedProvider } from "@/lib/conduitEmbedded";

const TABS = [
  { href: "/app/pay", label: "Pay" },
  { href: "/app/subscriptions", label: "Subscriptions" },
  { href: "/app/portfolio", label: "Portfolio" },
];

function shorten(a?: string) {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "";
}

export function ConduitPayShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { address, provider, signOut } = useActiveWallet();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  };

  const Tabs = ({ className = "" }: { className?: string }) => (
    <nav className={className}>
      {TABS.map((t) => {
        const active = pathname.startsWith(t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-[13px] transition-colors ${
              active ? "bg-conduit-cyan/10 text-white" : "text-conduit-muted hover:text-white"
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );

  return (
    <div className="min-h-screen bg-conduit-bg">
      <header className="sticky top-0 z-40 border-b border-conduit-border/70 bg-conduit-bg/80 backdrop-blur">
        <div className="mx-auto max-w-6xl px-4 sm:px-5">
          {/* top row */}
          <div className="flex items-center gap-3 py-3">
            <Link href="/app/pay" className="text-[15px] font-semibold tracking-tight text-white">
              ConduitPay
            </Link>
            {/* desktop nav inline */}
            <Tabs className="ml-2 hidden items-center gap-1 sm:flex" />

            <div className="ml-auto flex items-center gap-2">
              <button
                onClick={copy}
                title={address ? `${address} · tap to copy` : ""}
                className="mono flex items-center gap-1.5 rounded-lg border border-conduit-border px-2.5 py-1.5 text-[12px] text-conduit-muted transition-colors hover:border-conduit-cyan/40 hover:text-white"
              >
                <span className={`h-1.5 w-1.5 rounded-full ${provider === "passkey" ? "bg-conduit-violet" : "bg-conduit-cyan"}`} />
                {copied ? "copied ✓" : shorten(address)}
                <span className="hidden text-conduit-muted/50 sm:inline">· {provider === "passkey" ? "passkey" : "wallet"}</span>
              </button>
              <button
                onClick={async () => { await signOut(); router.push("/"); }}
                className="rounded-lg border border-conduit-border px-3 py-1.5 text-[13px] text-conduit-muted transition-colors hover:border-conduit-magenta/50 hover:text-white"
              >
                <span className="hidden sm:inline">Sign out</span>
                <span className="sm:hidden">Exit</span>
              </button>
            </div>
          </div>
          {/* mobile nav row */}
          <Tabs className="-mx-1 flex items-center gap-1 overflow-x-auto pb-2 sm:hidden" />
        </div>
      </header>
      <main>
        <EmbeddedProvider>{children}</EmbeddedProvider>
      </main>
    </div>
  );
}

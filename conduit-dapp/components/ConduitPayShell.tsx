"use client";
/**
 * The ConduitPay app shell — the persistent chrome once you're signed in: brand,
 * tab nav (Pay / Subscriptions / Portfolio), the connected wallet chip, and sign
 * out (which closes the auth gate and returns you to the sign-in screen).
 */
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { useActiveWallet } from "@/lib/activeWallet";

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

  return (
    <div className="min-h-screen bg-conduit-bg">
      <header className="sticky top-0 z-40 border-b border-conduit-border/70 bg-conduit-bg/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-5 py-3">
          <Link href="/app/pay" className="flex items-center gap-2">
            <span className="text-[15px] font-semibold tracking-tight text-white">ConduitPay</span>
          </Link>
          <nav className="flex items-center gap-1">
            {TABS.map((t) => {
              const active = pathname.startsWith(t.href);
              return (
                <Link
                  key={t.href}
                  href={t.href}
                  className={`rounded-lg px-3 py-1.5 text-[13px] transition-colors ${
                    active ? "bg-conduit-cyan/10 text-white" : "text-conduit-muted hover:text-white"
                  }`}
                >
                  {t.label}
                </Link>
              );
            })}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <span className="mono hidden items-center gap-1.5 rounded-lg border border-conduit-border px-2.5 py-1.5 text-[12px] text-conduit-muted sm:flex">
              <span className={`h-1.5 w-1.5 rounded-full ${provider === "passkey" ? "bg-conduit-violet" : "bg-conduit-cyan"}`} />
              {shorten(address)}
              <span className="text-conduit-muted/50">· {provider === "passkey" ? "passkey" : "wallet"}</span>
            </span>
            <button
              onClick={async () => { await signOut(); router.push("/"); }}
              className="rounded-lg border border-conduit-border px-3 py-1.5 text-[13px] text-conduit-muted transition-colors hover:border-conduit-magenta/50 hover:text-white"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main>{children}</main>
    </div>
  );
}

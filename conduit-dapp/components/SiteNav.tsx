import Image from "next/image";
import Link from "next/link";

const links = [
  { href: "#how", label: "How it works" },
  { href: "#products", label: "Products" },
  { href: "#safety", label: "Safety" },
  { href: "#build", label: "For developers" },
  { href: "#proof", label: "Proof" },
];

export function SiteNav() {
  return (
    <header className="fixed top-0 inset-x-0 z-50">
      <div className="mx-auto max-w-6xl px-6">
        <nav className="mt-4 flex items-center justify-between rounded-2xl border border-conduit-border bg-black/60 px-4 py-2.5 backdrop-blur-xl">
          <Link href="/" className="flex items-center gap-2.5">
            <Image
              src="/images/conduit-logo.png"
              alt="Conduit"
              width={32}
              height={32}
              className="h-8 w-8"
              priority
            />
            <span className="text-[15px] font-semibold tracking-tight">
              Conduit
            </span>
          </Link>

          <div className="hidden items-center gap-7 md:flex">
            {links.map((l) => (
              <a
                key={l.href}
                href={l.href}
                className="text-sm text-conduit-muted transition-colors hover:text-white"
              >
                {l.label}
              </a>
            ))}
          </div>

          <div className="flex items-center gap-4">
            <Link href="/docs" className="hidden text-sm text-conduit-muted transition-colors hover:text-white md:block">
              Docs
            </Link>
            <Link href="/app" className="btn-primary text-sm">
              Launch ConduitPay
            </Link>
          </div>
        </nav>
      </div>
    </header>
  );
}

import Image from "next/image";

export function SiteFooter() {
  return (
    <footer className="border-t border-conduit-border/60 py-12">
      <div className="mx-auto max-w-6xl px-6">
        <div className="flex flex-col items-center justify-between gap-6 md:flex-row">
          <div className="flex items-center gap-2.5">
            <Image
              src="/images/conduit-logo.png"
              alt="Conduit"
              width={28}
              height={28}
              className="h-7 w-7"
            />
            <span className="text-sm font-semibold">Conduit</span>
          </div>

          <p className="text-center text-sm text-conduit-muted">
            Open x402 + ERC-7710 facilitator · built on MetaMask Smart Accounts
          </p>

          <div className="flex items-center gap-5 text-sm text-conduit-muted">
            <a href="#" className="transition-colors hover:text-white">
              Blog
            </a>
            <a href="#" className="transition-colors hover:text-white">
              GitHub
            </a>
            <a href="#" className="transition-colors hover:text-white">
              X
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}

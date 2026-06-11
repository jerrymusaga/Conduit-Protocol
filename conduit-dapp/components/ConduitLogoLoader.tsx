"use client";
/** A branded full-screen loader: the Conduit logo with a pulsing glow + ping ring. */
export function ConduitLogoLoader({ label = "Loading ConduitPay…" }: { label?: string }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-conduit-bg">
      <div className="relative flex h-24 w-24 items-center justify-center">
        {/* pinging ring */}
        <span className="absolute inline-flex h-16 w-16 animate-ping rounded-full bg-conduit-cyan/20" />
        {/* soft glow */}
        <span className="absolute inline-flex h-20 w-20 animate-pulse rounded-full bg-conduit-cyan/10 blur-2xl" />
        {/* logo */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/images/conduit-logo.png"
          alt="Conduit"
          className="relative h-16 w-16 object-contain drop-shadow-[0_0_18px_rgba(0,229,255,0.45)]"
          style={{ animation: "cpulse 2s ease-in-out infinite" }}
        />
      </div>
      <span className="mono text-[13px] tracking-wide text-conduit-muted">{label}</span>
      <style jsx>{`
        @keyframes cpulse {
          0%, 100% { transform: scale(1); opacity: 0.92; }
          50% { transform: scale(1.06); opacity: 1; }
        }
      `}</style>
    </div>
  );
}

import Link from "next/link";
import Image from "next/image";
import { SiteNav } from "@/components/SiteNav";
import { SiteFooter } from "@/components/SiteFooter";

export default function Landing() {
  return (
    <main className="relative overflow-hidden">
      <SiteNav />

      {/* ambient glows */}
      <div className="pointer-events-none absolute left-1/2 top-[-12rem] h-[520px] w-[820px] -translate-x-1/2 rounded-full bg-conduit-cyan/10 blur-[140px]" />
      <div className="pointer-events-none absolute right-[-10rem] top-[28rem] h-[420px] w-[420px] rounded-full bg-conduit-violet/10 blur-[140px]" />

      {/* ===================== HERO ===================== */}
      <section className="relative px-6 pt-36 pb-20">
        <div className="mx-auto grid max-w-6xl items-center gap-12 lg:grid-cols-2">
          {/* left — message */}
          <div>
            <div className="reveal">
              <span className="eyebrow">Custom x402 facilitator · ERC-7710 · MetaMask Delegation Framework</span>
            </div>
            <h1 className="reveal mt-6 text-balance text-5xl font-semibold leading-[1.05] tracking-tight sm:text-6xl" style={{ animationDelay: "80ms" }}>
              Pay AI agents you
              <br />
              <span className="text-gradient-anim">don&apos;t have to trust.</span>
            </h1>
            <p className="reveal mt-6 max-w-xl text-lg leading-relaxed text-conduit-muted" style={{ animationDelay: "160ms" }}>
              Conduit binds every agent payment to a permission you sign — exact amount,
              recipient, intent — enforced on-chain. A fully compromised agent still can&apos;t
              overspend, redirect, or pay anyone you didn&apos;t approve.
            </p>
            <div className="reveal mt-8 flex flex-wrap items-center gap-3" style={{ animationDelay: "240ms" }}>
              <Link href="/app" className="btn-primary">
                Launch ConduitPay <span aria-hidden>→</span>
              </Link>
              <Link href="/docs" className="btn-ghost">Read the docs</Link>
            </div>
            <div className="reveal mt-9 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-conduit-muted" style={{ animationDelay: "320ms" }}>
              <span className="opacity-70">Built on</span>
              <span className="font-medium text-white/80">MetaMask</span>
              <span className="text-conduit-border">·</span>
              <span className="font-medium text-white/80">1Shot</span>
              <span className="text-conduit-border">·</span>
              <span className="font-medium text-white/80">Venice AI</span>
            </div>
          </div>

          {/* right — the signed-permission mockup (the product, not an illustration) */}
          <div className="reveal" style={{ animationDelay: "300ms" }}>
            <div className="panel relative p-6 shadow-glow-violet">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Image src="/images/conduit-logo.png" alt="" width={22} height={22} className="h-5 w-5" />
                  <span className="text-sm font-medium text-white">Authorization</span>
                </div>
                <span className="mono rounded-md bg-conduit-cyan/15 px-2 py-0.5 text-[11px] text-conduit-cyan">signed ✓</span>
              </div>
              <div className="mono mt-4 space-y-2 rounded-xl border border-conduit-border/70 bg-black/40 p-4 text-[13px]">
                {[
                  ["pay up to", "2.00 USDC"],
                  ["to", "your approved agents"],
                  ["per request", "≤ the exact quote"],
                  ["proceeds to", "your account"],
                  ["expires", "in 24h · revocable"],
                ].map(([k, v]) => (
                  <div key={k} className="flex items-center justify-between gap-3">
                    <span className="text-conduit-muted">{k}</span>
                    <span className="text-white">{v}</span>
                  </div>
                ))}
              </div>
              <p className="mt-4 text-[12px] leading-relaxed text-conduit-muted">
                The agent physically can&apos;t overspend this cap, accept a worse fill, buy a token
                off your set, or redirect the proceeds — the enforcer rejects it on-chain.
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                <span className="mono rounded-md border border-conduit-magenta/40 bg-conduit-magenta/[0.07] px-2 py-1 text-[11px] text-conduit-magenta/90">rogue: redirect → blocked</span>
                <span className="mono rounded-md border border-conduit-magenta/40 bg-conduit-magenta/[0.07] px-2 py-1 text-[11px] text-conduit-magenta/90">rogue: overspend → blocked</span>
              </div>
            </div>
          </div>
        </div>

        {/* the hook band */}
        <div className="reveal mx-auto mt-20 max-w-4xl text-center" style={{ animationDelay: "420ms" }}>
          <p className="text-2xl font-semibold tracking-tight sm:text-3xl">
            <span className="text-white">1 signature.</span>{" "}
            <span className="text-gradient">N agents.</span>{" "}
            <span className="text-white">1 transaction.</span>
          </p>
        </div>
      </section>

      <div className="beam mx-auto max-w-5xl" />

      {/* ===================== HOW IT WORKS ===================== */}
      <section id="how" className="scroll-mt-24 px-6 py-24">
        <div className="mx-auto max-w-6xl">
          <div className="max-w-2xl">
            <span className="eyebrow">How it works</span>
            <h2 className="mt-6 text-3xl font-semibold tracking-tight sm:text-4xl">
              Authorize once. The agents do the rest — bounded.
            </h2>
          </div>
          <div className="mt-14 grid gap-5 md:grid-cols-3">
            {[
              { step: "01", title: "Sign one permission", body: "From an embedded wallet or passkey, you sign a bounded permission on MetaMask's Delegation Framework — a set of agents or assets, a cap, an expiry." },
              { step: "02", title: "The coordinator hires", body: "A coordinator agent discovers the best agents on an ERC-8004 registry and pays each through erc7710 — every payment locked to one exact x402 request." },
              { step: "03", title: "Settle in one tx", body: "Conduit's facilitator settles it all through 1Shot's permissionless relayer — one transaction, one fee, gas paid in USDC. An on-chain receipt per payment." },
            ].map((c, i) => (
              <div key={c.step} className="panel panel-hover reveal p-6" style={{ animationDelay: `${i * 90}ms` }}>
                <div className="mono text-sm text-conduit-cyan">{c.step}</div>
                <h3 className="mt-3 text-xl font-semibold">{c.title}</h3>
                <p className="mt-2 text-[15px] leading-relaxed text-conduit-muted">{c.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <div className="beam mx-auto max-w-5xl" />

      {/* ===================== SAFETY ===================== */}
      <section id="safety" className="scroll-mt-24 px-6 py-28">
        <div className="mx-auto max-w-6xl">
          <div className="grid items-center gap-14 md:grid-cols-2">
            <div>
              <span className="eyebrow">The thesis</span>
              <h2 className="mt-6 text-3xl font-semibold tracking-tight sm:text-4xl">
                Security that doesn&apos;t depend on the agent <span className="text-gradient">behaving.</span>
              </h2>
              <p className="mt-6 text-lg leading-relaxed text-conduit-muted">
                Compromise an agent — prompt injection, a poisoned dependency, a breached server.
                It still can&apos;t step outside the permission you signed. You don&apos;t detect the
                cheating; you make it impossible by construction.
              </p>
              <ul className="mt-7 space-y-4">
                {[
                  ["Bounded, not trusted", "Wrong token, wrong recipient, over budget, bad fill — all reverted by the enforcer on-chain, not in the UI."],
                  ["Revoke anytime", "Kill the root permission and every agent's rights die at once, atomically. Your kill switch is one tx away."],
                  ["A real receipt", "Every settlement is on-chain and tx-linked — the x402 request bound to the payment that fulfilled it."],
                ].map(([t, b]) => (
                  <li key={t} className="flex gap-3">
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-conduit-cyan shadow-glow" />
                    <div>
                      <div className="font-medium">{t}</div>
                      <div className="text-[15px] text-conduit-muted">{b}</div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
            <Image
              src="/images/delegation-chain.png"
              alt="Conduit delegation chain"
              width={720}
              height={900}
              className="w-full rounded-2xl border border-conduit-border shadow-glow-violet object-cover"
              style={{ aspectRatio: "4 / 5" }}
            />
          </div>
        </div>
      </section>

      <div className="beam mx-auto max-w-5xl" />

      {/* ===================== FOR DEVELOPERS ===================== */}
      <section id="build" className="scroll-mt-24 px-6 py-28">
        <div className="mx-auto max-w-6xl">
          <div className="grid items-center gap-14 md:grid-cols-2">
            <div className="order-2 md:order-1">
              <div className="panel p-6">
                <div className="mono space-y-1.5 text-[13px] leading-relaxed">
                  <div className="text-conduit-muted">// no Solidity. inherit the caveat family.</div>
                  <div><span className="text-conduit-cyan">const</span> req = <span className="text-conduit-violet">await</span> fetch402(<span className="text-white">&quot;/services/yield-scout&quot;</span>)</div>
                  <div><span className="text-conduit-cyan">const</span> pay = buildPayment(&#123; grant, coordinator, req &#125;)</div>
                  <div>settle(pay) <span className="text-conduit-muted">// → 1Shot relayer, gas in USDC</span></div>
                  <div className="pt-2 text-conduit-muted">// bounded by SwapAllowlist · X402Receipt · ApproveBounds…</div>
                </div>
              </div>
            </div>
            <div className="order-1 md:order-2">
              <span className="eyebrow">For developers</span>
              <h2 className="mt-6 text-3xl font-semibold tracking-tight sm:text-4xl">
                Make agents safe to pay — <span className="text-gradient">without a line of Solidity.</span>
              </h2>
              <p className="mt-6 text-lg leading-relaxed text-conduit-muted">
                Conduit is a custom x402 facilitator plus a family of safety caveats on MetaMask&apos;s
                Delegation Framework. Integrate it and your agents inherit them all — bounded payments,
                swap allowlists, approvals, subscriptions. No enforcer to write or audit.
              </p>
              <div className="mt-7 flex flex-wrap gap-2">
                {["X402Receipt", "X402Subscription", "SwapAllowlist", "SwapBounds", "ApproveBounds"].map((c) => (
                  <span key={c} className="mono rounded-md border border-conduit-border px-2.5 py-1 text-[12px] text-conduit-muted">{c}</span>
                ))}
              </div>
              <div className="mt-8">
                <Link href="/docs" className="btn-ghost">Developer docs <span aria-hidden>→</span></Link>
              </div>
            </div>
          </div>
        </div>
      </section>

      <div className="beam mx-auto max-w-5xl" />

      {/* ===================== BUILT ON ===================== */}
      <section id="built" className="scroll-mt-24 px-6 py-28">
        <div className="mx-auto max-w-6xl text-center">
          <span className="eyebrow">Built on</span>
          <h2 className="mt-6 text-3xl font-semibold tracking-tight sm:text-4xl">The best of the agentic stack, composed.</h2>
          <div className="mt-14 grid gap-5 md:grid-cols-3">
            {[
              { name: "MetaMask Delegation Framework", body: "Advanced Permissions (ERC-7715), redelegation (ERC-7710), and EIP-7702 account upgrades — the rails Conduit extends with a custom caveat family." },
              { name: "1Shot Permissionless Relayer", body: "Settles redeemDelegations with gas paid in stablecoins and EIP-7702 bundled in. N payments share one transaction and one fee." },
              { name: "Venice AI", body: "Permissionless intelligence — the coordinator reasons with Venice, and the paid Yield Scout reasons over your approved set with live market data." },
            ].map((c, i) => (
              <div key={c.name} className="panel panel-hover reveal p-7 text-left" style={{ animationDelay: `${i * 90}ms` }}>
                <h3 className="text-lg font-semibold">{c.name}</h3>
                <p className="mt-3 text-[15px] leading-relaxed text-conduit-muted">{c.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <div className="beam mx-auto max-w-5xl" />

      {/* ===================== PROOF ===================== */}
      <section id="proof" className="scroll-mt-24 px-6 py-28">
        <div className="mx-auto max-w-4xl text-center">
          <span className="eyebrow">Proof</span>
          <h2 className="mt-6 text-3xl font-semibold tracking-tight sm:text-4xl">Every claim is verifiable on-chain.</h2>
          <div className="mt-12 grid gap-5 sm:grid-cols-3">
            {[
              ["5 enforcers deployed", "Receipt · Subscription · SwapAllowlist · SwapBounds · ApproveBounds"],
              ["All-or-nothing", "N payments settle in one redeemDelegations, or none do"],
              ["Compromise-proof", "Rogue redirect / overspend / off-list all revert on-chain"],
            ].map(([t, b], i) => (
              <div key={t} className="panel reveal p-6" style={{ animationDelay: `${i * 90}ms` }}>
                <div className="text-xl font-semibold text-gradient">{t}</div>
                <div className="mt-2 text-sm text-conduit-muted">{b}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ===================== FINAL CTA ===================== */}
      <section className="px-6 pb-32 pt-10">
        <div className="mx-auto max-w-4xl">
          <div className="panel relative overflow-hidden px-8 py-16 text-center">
            <div
              className="pointer-events-none absolute inset-0 opacity-70"
              style={{ background: "radial-gradient(40rem 16rem at 50% 0%, rgba(124,58,237,0.25), transparent 60%)" }}
            />
            <div className="relative">
              <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">Pay an agent — and watch it fail to cheat.</h2>
              <p className="mx-auto mt-5 max-w-xl text-lg text-conduit-muted">
                Sign in, hand an agent team a bounded budget, and try to make a compromised one misbehave.
                It can&apos;t.
              </p>
              <div className="mt-8 flex flex-wrap justify-center gap-3">
                <Link href="/app" className="btn-primary">Launch ConduitPay <span aria-hidden>→</span></Link>
                <Link href="/docs" className="btn-ghost">Read the docs</Link>
              </div>
            </div>
          </div>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}

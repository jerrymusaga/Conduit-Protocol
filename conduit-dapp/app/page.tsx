import Image from "next/image";
import Link from "next/link";
import { SiteNav } from "@/components/SiteNav";
import { SiteFooter } from "@/components/SiteFooter";
import { IllustrationSlot } from "@/components/IllustrationSlot";

export default function Landing() {
  return (
    <main className="relative">
      <SiteNav />

      {/* ===================== HERO ===================== */}
      <section className="relative px-6 pt-40 pb-24">
        <div className="mx-auto max-w-4xl text-center">
          {/* Logo, glowing, floating */}
          <div className="reveal mb-8 flex justify-center" style={{ animationDelay: "0ms" }}>
            <Image
              src="/images/conduit-logo.png"
              alt="Conduit"
              width={140}
              height={140}
              priority
              className="float-slow h-32 w-32 drop-shadow-[0_0_40px_rgba(0,229,255,0.45)]"
            />
          </div>

          <div className="reveal" style={{ animationDelay: "80ms" }}>
            <span className="eyebrow">x402 · ERC-7710 · MetaMask Smart Accounts</span>
          </div>

          <h1
            className="reveal mt-6 text-balance text-5xl font-semibold leading-[1.05] tracking-tight sm:text-6xl md:text-7xl"
            style={{ animationDelay: "160ms" }}
          >
            Payments your agents
            <br />
            <span className="text-gradient-anim">cannot misuse.</span>
          </h1>

          <p
            className="reveal mx-auto mt-7 max-w-2xl text-lg leading-relaxed text-conduit-muted"
            style={{ animationDelay: "240ms" }}
          >
            Conduit is an open x402 facilitator built on MetaMask Smart
            Accounts. It binds every agent payment to one specific request,
            on-chain — and settles gas in stablecoins. Hand an autonomous
            agent a budget it physically cannot overspend, redirect, or replay.
          </p>

          <div
            className="reveal mt-9 flex flex-wrap items-center justify-center gap-3"
            style={{ animationDelay: "320ms" }}
          >
            <Link href="/demo" className="btn-primary">
              Launch the demo
              <span aria-hidden>→</span>
            </Link>
            <a href="#how" className="btn-ghost">
              See how it works
            </a>
          </div>

          {/* trust row */}
          <div
            className="reveal mt-12 flex flex-wrap items-center justify-center gap-x-8 gap-y-3 text-sm text-conduit-muted"
            style={{ animationDelay: "400ms" }}
          >
            <span className="opacity-70">Built on</span>
            <span className="font-medium text-white/80">MetaMask Smart Accounts</span>
            <span className="text-conduit-border">·</span>
            <span className="font-medium text-white/80">1Shot Permissionless Relayer</span>
            <span className="text-conduit-border">·</span>
            <span className="font-medium text-white/80">Venice AI</span>
          </div>
        </div>

        {/* Hero visual zone — the big animated convergence / flow */}
        <div className="reveal mx-auto mt-20 max-w-5xl" style={{ animationDelay: "480ms" }}>
          <img
            src="/images/hero-flow.png"
            alt="Conduit payment flow"
            className="w-full rounded-2xl border border-conduit-border shadow-glow-violet object-cover"
            style={{ aspectRatio: "16 / 8" }}
          />

        </div>
      </section>

      <div className="beam mx-auto max-w-5xl" />

      {/* ===================== WHAT IS CONDUIT ===================== */}
      <section className="px-6 py-28">
        <div className="mx-auto max-w-4xl text-center">
          <span className="eyebrow">The problem</span>
          <h2 className="mt-6 text-3xl font-semibold tracking-tight sm:text-4xl">
            Giving an AI agent a wallet is{" "}
            <span className="text-gradient">terrifying.</span>
          </h2>
          <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-conduit-muted">
            Today you either over-trust an agent with broad spending power, or
            you babysit every transaction. Neither scales to autonomous agents
            that pay for things on your behalf. Conduit makes a third option
            real: a budget you delegate once, scoped so tightly that even a
            fully compromised agent can only make the exact payment you
            authorized.
          </p>
        </div>
      </section>

      {/* ===================== HOW IT WORKS ===================== */}
      <section id="how" className="scroll-mt-24 px-6 py-24">
        <div className="mx-auto max-w-6xl">
          <div className="max-w-2xl">
            <span className="eyebrow">How it works</span>
            <h2 className="mt-6 text-3xl font-semibold tracking-tight sm:text-4xl">
              An x402 payment, settled through a MetaMask delegation.
            </h2>
            <p className="mt-5 text-lg leading-relaxed text-conduit-muted">
              A server quotes a price with HTTP 402. The agent pays with a
              MetaMask Smart Account delegation. Conduit verifies it by
              simulation, then settles it on-chain through 1Shot — gas paid in
              USDC, no ETH required.
            </p>
          </div>

          <div className="mt-14 grid gap-5 md:grid-cols-3">
            {[
              {
                step: "01",
                title: "Ask cleanly",
                body: "The user grants a scoped permission through MetaMask Advanced Permissions (ERC-7715). A clear dialog, not a blanket approval.",
              },
              {
                step: "02",
                title: "Execute in-bounds",
                body: "A coordinator redelegates narrow rights to task agents. Conduit's X402ReceiptEnforcer binds each payment to one exact request.",
              },
              {
                step: "03",
                title: "Settle + receipt",
                body: "1Shot's Permissionless Relayer submits redeemDelegations. Gas in stablecoins. An on-chain receipt links request → settlement.",
              },
            ].map((c, i) => (
              <div
                key={c.step}
                className="panel panel-hover reveal p-6"
                style={{ animationDelay: `${i * 90}ms` }}
              >
                <div className="mono text-sm text-conduit-cyan">{c.step}</div>
                <h3 className="mt-3 text-xl font-semibold">{c.title}</h3>
                <p className="mt-2 text-[15px] leading-relaxed text-conduit-muted">
                  {c.body}
                </p>
              </div>
            ))}
          </div>

          {/* Architecture visual zone */}
          <div className="mt-14">
            <img
              src="/images/architecture.png"
              alt="Conduit system architecture"
              className="w-full rounded-2xl border border-conduit-border object-cover"
              style={{ aspectRatio: "16 / 9" }}
            />

          </div>
        </div>
      </section>

      <div className="beam mx-auto max-w-5xl" />

      {/* ===================== SAFETY (the innovation) ===================== */}
      <section id="safety" className="scroll-mt-24 px-6 py-28">
        <div className="mx-auto max-w-6xl">
          <div className="grid items-center gap-14 md:grid-cols-2">
            <div>
              <span className="eyebrow">The innovation</span>
              <h2 className="mt-6 text-3xl font-semibold tracking-tight sm:text-4xl">
                A coordinator root.
                <br />
                <span className="text-gradient">Narrow task agents.</span>
                <br />
                Kill the root, all die.
              </h2>
              <p className="mt-6 text-lg leading-relaxed text-conduit-muted">
                Don&apos;t give one agent broad access. Give a coordinator a
                root policy, then let it redelegate narrow rights to task
                agents — discover, execute, claim. Each one is scoped to a
                single job and can do nothing else.
              </p>
              <ul className="mt-7 space-y-4">
                {[
                  ["Execute only inside the grant", "Over-spend, redirect, or replay attempts revert on-chain — not in the UI, in the contract."],
                  ["Revocable by default", "Disable the root delegation and every downstream agent's rights die at once, atomically."],
                  ["A useful receipt", "Every settlement emits X402IntentSettled, linking the x402 request to the on-chain payment."],
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

            {/* Delegation-chain visual zone */}
            <img
              src="/images/delegation-chain.png"
              alt="Conduit delegation chain"
              className="w-full rounded-2xl border border-conduit-border shadow-glow-violet object-cover"
              style={{ aspectRatio: "4 / 5" }}
            />

          </div>
        </div>
      </section>

      <div className="beam mx-auto max-w-5xl" />

      {/* ===================== BUILT ON ===================== */}
      <section id="built" className="scroll-mt-24 px-6 py-28">
        <div className="mx-auto max-w-6xl text-center">
          <span className="eyebrow">Built on</span>
          <h2 className="mt-6 text-3xl font-semibold tracking-tight sm:text-4xl">
            The best of the agentic stack, composed.
          </h2>

          <div className="mt-14 grid gap-5 md:grid-cols-3">
            {[
              {
                name: "MetaMask Smart Accounts",
                body: "Advanced Permissions (ERC-7715), the Delegation Framework (ERC-7710), and EIP-7702 account upgrades — the foundation Conduit is built on.",
              },
              {
                name: "1Shot Permissionless Relayer",
                body: "Settles redeemDelegations on mainnet with gas paid in stablecoins, EIP-7702 bundled in. Webhooks drive settlement status.",
              },
              {
                name: "Venice AI",
                body: "Permissionless intelligence — the agent reasons with Venice and the asset it buys is a Venice generation. Multiple endpoints, one flow.",
              },
            ].map((c, i) => (
              <div
                key={c.name}
                className="panel panel-hover reveal p-7 text-left"
                style={{ animationDelay: `${i * 90}ms` }}
              >
                <h3 className="text-lg font-semibold">{c.name}</h3>
                <p className="mt-3 text-[15px] leading-relaxed text-conduit-muted">
                  {c.body}
                </p>
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
          <h2 className="mt-6 text-3xl font-semibold tracking-tight sm:text-4xl">
            Every claim is verifiable on-chain.
          </h2>
          <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-conduit-muted">
            The enforcer is deployed and verified. The architecture was
            de-risked against the live MetaMask DelegationManager before a line
            of product code was written.
          </p>

          <div className="mt-12 grid gap-5 sm:grid-cols-3">
            {[
              ["Enforcer deployed", "X402ReceiptEnforcer, verified on BaseScan"],
              ["1,500 bytes intact", "1Shot relays delegation chains byte-for-byte"],
              ["Custom caveat fires", "X402IntentSettled emitted on the redelegation hop"],
            ].map(([t, b], i) => (
              <div
                key={t}
                className="panel reveal p-6"
                style={{ animationDelay: `${i * 90}ms` }}
              >
                <div className="text-xl font-semibold text-gradient">{t}</div>
                <div className="mt-2 text-sm text-conduit-muted">{b}</div>
              </div>
            ))}
          </div>

          <p className="mono mt-8 break-all text-xs text-conduit-muted">
            X402ReceiptEnforcer · Base Sepolia ·
            0x111115259a41bd174c7C1f6B7eE36ec1Ab3CD5c1
          </p>
        </div>
      </section>

      {/* ===================== FINAL CTA ===================== */}
      <section className="px-6 pb-32 pt-10">
        <div className="mx-auto max-w-4xl">
          <div className="panel relative overflow-hidden px-8 py-16 text-center">
             <img
                src="/images/section-bg.png"
                alt=""
                aria-hidden
                className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-40"
              />
            <div
              className="pointer-events-none absolute inset-0 opacity-70"
              style={{
                background:
                  "radial-gradient(40rem 16rem at 50% 0%, rgba(124,58,237,0.25), transparent 60%)",
              }}
            />
            <div className="relative">
              <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">
                See an agent pay — and fail to cheat.
              </h2>
              <p className="mx-auto mt-5 max-w-xl text-lg text-conduit-muted">
                Watch a coordinator delegate a budget, a task agent pay for a
                resource, and a compromised agent get rejected on-chain.
              </p>
              <div className="mt-8 flex justify-center">
                <Link href="/demo" className="btn-primary">
                  Launch the demo
                  <span aria-hidden>→</span>
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}

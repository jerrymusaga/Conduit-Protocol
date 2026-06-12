import Image from "next/image";
import Link from "next/link";
import { config } from "@/lib/config";

/* ===========================================================================
   Conduit — developer docs ("Build with Conduit").
   The integrator surface: what Conduit is, the facilitator API, how to build a
   payment, webhooks, and addresses. Brand-styled (matches the landing page),
   self-contained so it ships in one deploy. Static server component.
   =========================================================================== */

export const metadata = {
  title: "Conduit — Docs",
  description: "Build with Conduit: the open x402 + ERC-7710 facilitator.",
};

const SECTIONS = [
  ["what", "What is Conduit"],
  ["quickstart", "Quickstart"],
  ["api", "Facilitator API"],
  ["payment", "Build a payment"],
  ["subscriptions", "Subscriptions"],
  ["enforcers", "Enforcers"],
  ["bounds", "Bounds & revocation"],
  ["webhooks", "Webhooks"],
  ["addresses", "Addresses"],
] as const;

export default function Docs() {
  const baseSepolia = config.chainId === 84532;
  return (
    <main className="min-h-screen">
      {/* top bar */}
      <div className="sticky top-0 z-40 border-b border-conduit-border/60 bg-black/70 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link href="/" className="flex items-center gap-2.5">
            <Image src="/images/conduit-logo.png" alt="Conduit" width={28} height={28} className="h-7 w-7" />
            <span className="font-semibold tracking-tight">Conduit</span>
            <span className="mono ml-2 rounded-md border border-conduit-border px-2 py-0.5 text-[11px] text-conduit-muted">
              docs
            </span>
          </Link>
          <Link href="/demo" className="btn-primary text-sm">Launch demo</Link>
        </div>
      </div>

      <div className="mx-auto grid max-w-6xl gap-10 px-6 py-12 lg:grid-cols-12">
        {/* sidebar */}
        <aside className="lg:col-span-3">
          <nav className="sticky top-24 space-y-1">
            {SECTIONS.map(([id, label]) => (
              <a
                key={id}
                href={`#${id}`}
                className="block rounded-lg px-3 py-1.5 text-sm text-conduit-muted transition-colors hover:bg-white/5 hover:text-white"
              >
                {label}
              </a>
            ))}
          </nav>
        </aside>

        {/* content */}
        <article className="space-y-16 lg:col-span-9">
          {/* WHAT */}
          <Section id="what" title="What is Conduit">
            <p className="lead">
              Conduit is an open <b className="text-white">x402 facilitator</b> that
              implements the <Mono>erc7710</Mono> settlement method on MetaMask Smart
              Accounts — and relays through the{" "}
              <b className="text-white">1Shot Permissionless Relayer</b>, so agents pay
              gas in stablecoins.
            </p>
            <p>
              Point any x402-protected resource at a Conduit facilitator and your
              callers get: settlement via on-chain delegation redemption, a family of
              on-chain caveats that bind every action — <Mono>X402ReceiptEnforcer</Mono>{" "}
              for one exact request, <Mono>X402SubscriptionEnforcer</Mono> for fixed
              recurring charges, and <Mono>SwapBounds</Mono>/<Mono>SwapAllowlist</Mono> for
              bounded agent trades — gas paid in USDC with no relayer to run, and clean
              settlement webhooks. Conduit is the rail; your agent is the caller.
            </p>
            <Callout>
              The safety property: a payment is fused to one recipient, one amount, one
              token, one request — fixed on-chain before the agent runs. A compromised
              agent can’t redirect or overspend it. A spending cap bounds the amount;
              Conduit binds the <i>payment</i>.
            </Callout>
          </Section>

          {/* QUICKSTART */}
          <Section id="quickstart" title="Quickstart">
            <p>
              The x402 exchange is three steps. Your resource returns <Mono>402</Mono>{" "}
              with Conduit in <Mono>extra</Mono>; the caller pays via the{" "}
              <Mono>X-PAYMENT</Mono> header; Conduit verifies + settles.
            </p>
            <Code>{`# 1. Caller hits your resource → 402 Payment Required
GET /paid-data            → 402  { accepts: [{ ...,
  extra: { assetTransferMethod: "erc7710",
           facilitator, delegationManager, receiptEnforcer,
           redeemer, feeCollector, relayBackend } } ] }

# 2. Caller builds an intent-bound redelegation and re-requests
GET /paid-data
  X-PAYMENT: base64(x402 payment payload)

# 3. Your server forwards to the facilitator → settles on-chain
POST {facilitator}/verify   → { isValid }
POST {facilitator}/settle   → { jobId, status, transaction }`}</Code>
            <p className="text-sm text-conduit-muted">
              The seller never holds funds or keys — it just relays the payment payload
              to the facilitator. Conduit (and 1Shot) do the rest.
            </p>
          </Section>

          {/* API */}
          <Section id="api" title="Facilitator API">
            <p>The facilitator is a small HTTP surface (x402 V2 shape + Conduit extensions).</p>
            <div className="rounded-lg border border-conduit-border/60 bg-black/30 p-3">
              <p className="text-[12px] uppercase tracking-wide text-conduit-muted/60">Conduit facilitator base URL</p>
              <p className="mt-1 break-all font-mono text-sm text-conduit-cyan">{config.facilitatorUrl}</p>
              <p className="mt-1 text-[12px] text-conduit-muted">
                Every <Mono>{`{facilitator}`}</Mono> below is this base URL. Probe it live:{" "}
                <Mono>GET {config.facilitatorUrl}/supported</Mono>.
              </p>
            </div>
            <Endpoint method="GET" path="/supported">
              Advertises the <Mono>erc7710</Mono> capability + the{" "}
              <Mono>conduit</Mono> block: <Mono>receiptEnforcer</Mono>,{" "}
              <Mono>delegationManager</Mono>, <Mono>relayBackend</Mono>,{" "}
              <Mono>redeemer</Mono> (the address the work delegation must name), and{" "}
              <Mono>feeCollector</Mono> (oneshot-pl only — where the buyer pays gas).
            </Endpoint>
            <Endpoint method="POST" path="/verify">
              Simulates the redemption on-chain. Returns{" "}
              <Mono>{`{ isValid, invalidReason }`}</Mono>. A bound payment that violates
              its caveats fails here with the real revert reason.
            </Endpoint>
            <Endpoint method="POST" path="/settle">
              Submits the redemption through the active relay backend. Returns a{" "}
              <Mono>jobId</Mono> + <Mono>transaction</Mono>. On oneshot-pl, this relays
              through 1Shot with gas paid in stablecoin.
            </Endpoint>
            <Endpoint method="GET" path="/events">
              Server-Sent Events: the live payment lifecycle (<Mono>request →
              permission → settle → settled</Mono>) for building a live console.
            </Endpoint>
            <Endpoint method="POST" path="/relayer-webhook">
              Inbound 1Shot status events (Ed25519-verified against the relayer JWKS) —
              the source of truth for settlement, forwarded to your webhook.
            </Endpoint>
          </Section>

          {/* PAYMENT */}
          <Section id="payment" title="Build a payment">
            <p>
              A payment is an intent-bound redelegation rooted in the user’s ERC-7715
              grant. The leaf carries two caveats:
            </p>
            <ul className="ml-5 list-disc space-y-1.5 text-conduit-muted">
              <li>
                <Mono>X402ReceiptEnforcer</Mono> — binds token + recipient + amount +
                intent hash (89-byte packed terms).
              </li>
              <li>
                <Mono>IdEnforcer</Mono> — one-shot: the intent can be redeemed once
                (replay-proof).
              </li>
            </ul>
            <Code>{`// the leaf delegation: signer → facilitator's redeemer
const caveats = [
  { enforcer: idEnforcer,
    terms: abiEncode(["uint256"], [BigInt(intentHash)]) },
  { enforcer: receiptEnforcer,          // X402ReceiptEnforcer
    terms: packed(["bytes32","address","address","uint128","uint8"],
                  [intentHash, token, payTo, maxAmount, 0]) },
];
// sign it, encode the chain [leaf, …, root], send as the X-PAYMENT payload.`}</Code>
            <Callout>
              <b className="text-white">On the 1Shot path</b>, gas is paid in USDC — so a
              payment carries <i>two</i> bounded delegations merged into one batch: a
              fee delegation (pays the relayer’s <Mono>feeCollector</Mono>, capped at the
              live quote) and the work delegation above. Even the gas payment is
              intent-bound. The user’s account is upgraded to a MetaMask Smart Account
              via EIP-7702 in the same transaction.
            </Callout>
            <p className="text-sm text-conduit-muted">
              <b className="text-white">Roadmap — cross-chain:</b> 1Shot’s relayer also
              supports multichain settlement (<Mono>send7710TransactionMultichain</Mono>),
              so an agent’s stablecoin gas budget can live on one chain while the work
              executes on another, atomically. Conduit’s relay seam is built for it;
              shipping post-hackathon.
            </p>
            <p className="text-sm text-conduit-muted">
              In practice this is one call — Conduit’s client picks the right shape from
              the facilitator’s advertised <Mono>relayBackend</Mono>. See{" "}
              <Mono>lib/payment.ts</Mono> in the demo for a reference implementation.
            </p>
          </Section>

          {/* SUBSCRIPTIONS */}
          <Section id="subscriptions" title="Subscriptions">
            <p>
              For recurring charges, a service advertises a subscription instead of a
              one-shot price. Its <Mono>402</Mono> carries{" "}
              <Mono>paymentKind: &quot;subscription&quot;</Mono> and a{" "}
              <Mono>subscription</Mono> block:
            </p>
            <Code>{`GET /services/pulse-feed → 402  { accepts: [{ ...,
  extra: { paymentKind: "subscription",
           subscription: { enforcer, subscriptionId,
                           periodSeconds, amountPerPeriod } } }] }`}</Code>
            <p>
              The buyer signs a <b className="text-white">service-bound root</b> delegation
              whose caveat is the <Mono>X402SubscriptionEnforcer</Mono> — the user&rsquo;s own
              signature binds merchant + exact amount + cadence. 94-byte packed terms:
            </p>
            <Code>{`subscriptionId(bytes32) ++ token(address) ++ recipient(address)
  ++ amountPerPeriod(uint128) ++ periodDuration(uint32) ++ reserved(uint16)`}</Code>
            <p>
              Each period the agent can charge <i>exactly once</i>; a second charge in the
              same period reverts <Mono>X402Sub:already-charged-this-period</Mono> on-chain.
              Every charge emits <Mono>X402SubscriptionCharged</Mono>{" "}
              (<Mono>subscriptionId</Mono>, <Mono>amount</Mono>, <Mono>period</Mono>) for
              off-chain reconciliation.
            </p>
            <Callout>
              <b className="text-white">vs. a rolling spend cap:</b> a periodic{" "}
              <i>allowance</i> only limits &ldquo;up to X per window&rdquo; — it doesn&rsquo;t
              fix the recipient, the exact price, or prevent multiple charges. The
              subscription enforcer is a <b className="text-white">fixed-price,
              merchant-bound, once-per-period</b> charge with on-chain double-charge
              protection. That&rsquo;s the actual subscription semantic.
            </Callout>
            <p className="text-sm text-conduit-muted">
              On the 1Shot path the strict subscription root can&rsquo;t fund gas (it only
              authorizes the exact subscription transfer), so a subscription grant is{" "}
              <i>two</i> bounded user roots: the subscription root + a small gas-fee budget
              root. Both bounded, both user-approved. See <Mono>lib/subscription.ts</Mono>.
            </p>

            <p className="pt-2">
              <b className="text-white">Lifecycle.</b> Subscribe once (one signature) → the
              agent charges once per period → each charge buys a real deliverable → cancel
              any time. The period is tracked <i>on-chain</i> by the enforcer, so
              double-charge protection and the &ldquo;next charge in…&rdquo; countdown are
              both derived from the same on-chain truth — not a server clock.
            </p>
            <Endpoint method="DELIVERABLE" path="charge → product">
              A subscription isn&rsquo;t just a recurring transfer — each settled charge
              <i> delivers</i>. Conduit&rsquo;s demo products (Market Pulse, AI Alpha Daily,
              DeFi Yield Weekly) each return a live Venice-generated report for the period
              the charge paid for, attached to the on-chain receipt. The payment and the
              product settle together: no charge, no deliverable.
            </Endpoint>
            <Endpoint method="REVOKE" path="gasless cancel (no ETH)">
              Cancelling is <Mono>disableDelegation(subscriptionRoot)</Mono>. Conduit runs it{" "}
              <b className="text-white">gaslessly</b> — the relayer executes it from the
              user&rsquo;s account, bounded by MetaMask&rsquo;s AllowedTargets + AllowedMethods
              enforcers and reimbursed by a small USDC fee — so a fresh account with no ETH
              can still kill a subscription. Falls back to a direct tx if needed.
            </Endpoint>
            <Endpoint method="LOOP" path="intel → action">
              Subscriptions are <b className="text-white">intel</b>; Pay is{" "}
              <b className="text-white">action</b>. A deliverable carries an{" "}
              <i>&ldquo;Act on this in Pay →&rdquo;</i> handoff that deep-links into a matching
              bounded action — a token-intel report into a <Mono>SwapAllowlist</Mono> swap, a
              yield report into a <Mono>YieldAllowlist</Mono> deposit. The report tells you
              what to do; the enforcer guarantees the agent can only do <i>that</i>.
            </Endpoint>
          </Section>

          {/* ENFORCERS */}
          <Section id="enforcers" title="Enforcers">
            <p>
              The facilitator relays <i>any</i> ERC-7710 execution — Conduit ships the
              on-chain caveats that make payments <b className="text-white">safe</b>.
              Each binds a delegated transfer so a compromised agent can’t misuse it.
              The pattern is pluggable: one facilitator, many enforcers.
            </p>
            <Endpoint method="ENFORCER" path="X402ReceiptEnforcer">
              One-shot, intent-bound payment: binds token + recipient + amount +
              intent hash; pair with <Mono>IdEnforcer</Mono> for replay protection.
              The standard x402 pay-once flow.
            </Endpoint>
            <Endpoint method="ENFORCER" path="X402SubscriptionEnforcer">
              Recurring payment: binds token + recipient + <i>exact</i> amount, charged
              at most once per period. An agent can renew each period without a new
              grant — but can’t change the recipient/amount/token or double-charge.
            </Endpoint>

            <p className="pt-2">
              <b className="text-white">Beyond payments — trading.</b> The same pattern
              binds DEX swaps, so an agent can trade within bounds it cannot exceed. The
              facilitator relays these unchanged (its oneshot path is execution-agnostic).
            </p>
            <Endpoint method="ENFORCER" path="SwapBoundsEnforcer">
              One bounded Uniswap v3 swap: binds router + tokenIn/tokenOut +{" "}
              <Mono>maxAmountIn</Mono> + <Mono>minAmountOut</Mono> (slippage floor) +
              recipient. A hijacked agent can’t swap a different token, overspend, accept
              a worse fill, or redirect the proceeds. Emits <Mono>SwapBounded</Mono>.
            </Endpoint>
            <Endpoint method="ENFORCER" path="SwapAllowlistEnforcer">
              The dynamic-token version: the user signs a <i>set</i> of output tokens,
              each with its own floor (<Mono>router · tokenIn · maxIn · recipient · N ·
              [tokenOut·floor]×N</Mono>). A scout agent picks the best token{" "}
              <i>from the signed set</i> — choosing a token never gives reach beyond it.
            </Endpoint>
            <Endpoint method="ENFORCER" path="ApproveBoundsEnforcer">
              Bounds the ERC-20 <Mono>approve</Mono> a swap or deposit needs (token +
              spender + cap), so the allowance can ride the <i>same</i> 1Shot batch as the
              action — gas paid in USDC, the user never needs ETH, no standing approval.
            </Endpoint>
            <p className="pt-2">
              <b className="text-white">Beyond trading — yield.</b> The same pattern binds a
              lending-pool deposit, so an agent can move funds into yield within a venue set
              it cannot escape.
            </p>
            <Endpoint method="ENFORCER" path="YieldAllowlistEnforcer">
              One bounded Aave-V3 <Mono>supply</Mono>: the user signs a <i>set</i> of yield
              venues (<Mono>asset · maxIn · recipient · N · [pool·minAmount]×N</Mono>). A
              scout agent picks the best APY <i>from the signed set</i>; a hijacked agent
              can’t supply into a venue you didn’t approve, overspend, supply a different
              asset, or redirect the position. Emits <Mono>YieldAllowed</Mono>.
            </Endpoint>
            <Callout>
              All six <Mono>are CaveatEnforcer</Mono> — Conduit-custom caveats on the{" "}
              <b className="text-white">MetaMask Delegation Framework</b>’s extension point
              (override <Mono>beforeHook</Mono>), enforced by the unmodified
              DelegationManager on every hop. The allowlist enforcers (swap + yield) are
              what make “pick the best token/APY” safe: the agent can only ever choose from
              the set you signed.
            </Callout>
          </Section>

          {/* BOUNDS & REVOCATION */}
          <Section id="bounds" title="Bounds & revocation">
            <p>
              Every grant — one-shot budget or subscription — is bounded and revocable by
              the <b className="text-white">user</b>, not the agent.
            </p>
            <Endpoint method="CAVEAT" path="TimestampEnforcer — expiry">
              Adds a validity window: packed{" "}
              <Mono>(uint128 after, uint128 before)</Mono>. Past <Mono>before</Mono>,
              redemption reverts <Mono>TimestampEnforcer:expired-delegation</Mono>. Without
              it, a rolling period cap never actually expires on-chain — so Conduit attaches
              it to make the budget/subscription genuinely die at its deadline.
            </Endpoint>
            <Endpoint method="REVOKE" path="DelegationManager.disableDelegation(root)">
              The kill switch. Gated <Mono>onlyDeleGator(delegator)</Mono>, so the{" "}
              <b className="text-white">user&rsquo;s</b> account sends it — not the agent, not
              the relayer. Disabling the root <b className="text-white">cascades</b>: every
              child redelegation under it dies at once. A direct on-chain tx (needs gas).
            </Endpoint>
            <Callout>
              The blast radius is bounded by design: a compromised agent can never widen a
              delegation, the spend is caveat-fixed, the grant expires, and the user can
              revoke the whole tree in one call.
            </Callout>
          </Section>

          {/* WEBHOOKS */}
          <Section id="webhooks" title="Webhooks">
            <p>
              Settlement is asynchronous. Register a <Mono>WEBHOOK_URL</Mono> and Conduit
              pushes you a clean event the moment a payment confirms — on any relay path.
            </p>
            <Code>{`POST {your WEBHOOK_URL}
{
  "type": "conduit.settlement",
  "jobId": "…",
  "status": "confirmed",      // | "failed"
  "success": true,
  "txHash": "0x…",
  "error": null
}`}</Code>
            <p>
              Conduit consumes 1Shot’s Ed25519-signed webhooks (verifying them against
              the relayer’s JWKS), then forwards this simple event to you. You never
              touch the relayer, the chain, or signature verification.
            </p>
          </Section>

          {/* ADDRESSES */}
          <Section id="addresses" title="Addresses">
            <p className="text-sm text-conduit-muted">
              {baseSepolia ? "Base Sepolia (testnet)." : "Base mainnet (live)."} The full
              enforcer family is deployed and verified on both networks; these addresses
              reflect the chain this app is configured for.
            </p>
            <div className="space-y-2">
              <Addr label="X402ReceiptEnforcer" addr={config.receiptEnforcer} />
              <Addr label="X402SubscriptionEnforcer" addr={config.subscriptionEnforcer} />
              <Addr label="SwapBoundsEnforcer" addr={config.swapBoundsEnforcer} />
              <Addr label="SwapAllowlistEnforcer" addr={config.swapAllowlistEnforcer} />
              <Addr label="YieldAllowlistEnforcer" addr={config.yieldAllowlistEnforcer} />
              <Addr label="ApproveBoundsEnforcer" addr={config.approveBoundsEnforcer} />
              <Addr label="DelegationManager" addr={config.delegationManager} />
              <Addr label="IdEnforcer" addr={config.idEnforcer} />
              <Addr label="ERC20PeriodTransferEnforcer" addr={config.erc20PeriodTransferEnforcer} />
              <Addr label="TimestampEnforcer" addr={config.timestampEnforcer} />
              <Addr label="EIP7702 StatelessDeleGator" addr={config.eip7702Impl} />
              <Addr label="USDC" addr={config.usdc} />
            </div>
          </Section>

          <div className="border-t border-conduit-border/60 pt-8">
            <Link href="/demo" className="btn-primary text-sm">See it live →</Link>
          </div>
        </article>
      </div>
    </main>
  );
}

// --- doc primitives (brand-styled) ----------------------------------------

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-24">
      <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
      <div className="mt-4 space-y-4 text-[15px] leading-relaxed text-conduit-muted">
        {children}
      </div>
    </section>
  );
}

function Mono({ children }: { children: React.ReactNode }) {
  return <code className="mono rounded bg-white/5 px-1.5 py-0.5 text-[13px] text-conduit-cyan">{children}</code>;
}

function Code({ children }: { children: string }) {
  return (
    <pre className="panel mono overflow-x-auto p-4 text-[12.5px] leading-relaxed text-conduit-muted">
      <code>{children}</code>
    </pre>
  );
}

function Callout({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-conduit-cyan/25 bg-conduit-cyan/[0.04] p-4 text-[14px] leading-relaxed">
      {children}
    </div>
  );
}

function Endpoint({ method, path, children }: { method: string; path: string; children: React.ReactNode }) {
  return (
    <div className="panel p-4">
      <div className="flex items-center gap-2">
        <span className="mono rounded bg-conduit-violet/15 px-2 py-0.5 text-[11px] font-semibold text-conduit-violet">{method}</span>
        <span className="mono text-sm text-white">{path}</span>
      </div>
      <p className="mt-2 text-[13.5px] leading-relaxed text-conduit-muted">{children}</p>
    </div>
  );
}

function Addr({ label, addr }: { label: string; addr: string }) {
  const href = `${config.explorerUrl}/address/${addr}`;
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-conduit-border px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
      <span className="text-sm text-white">{label}</span>
      <a href={href} target="_blank" rel="noopener noreferrer" className="mono break-all text-[12px] text-conduit-cyan underline-offset-4 hover:underline">
        {addr}
      </a>
    </div>
  );
}

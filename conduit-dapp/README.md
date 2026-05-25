# Conduit — dapp

Conduit's demo + reference surface. A Next.js app with two routes:

- **`/`** — the landing page. The public face: what Conduit is, how it works,
  the safety model, what it's built on, proof.
- **`/demo`** — the working buyer flow: a coordinator delegates a budget,
  task agents (discover/execute/claim) transact, a compromised agent is
  rejected on-chain, and the root can be killed to cascade-revoke everything.

It's branded Conduit but built to **showcase the facilitator** — the product
is the facilitator + `X402ReceiptEnforcer`; this dapp shows them working.

```
app/
├── layout.tsx        fonts (Inter + JetBrains Mono), metadata
├── globals.css       the Conduit design system (gradients, glow, motion)
├── page.tsx          landing page
└── demo/page.tsx     the demo (currently MOCK state — see below)
components/
├── SiteNav.tsx · SiteFooter.tsx
└── IllustrationSlot.tsx   designed placeholders for generated visuals
lib/
└── config.ts         browser config (chain, facilitator/endpoint URLs, addresses)
public/images/
└── conduit-logo.png  the brand mark
ILLUSTRATIONS.md      prompts + placement for hero/section visuals
```

## Run

```bash
npm install
cp .env.example .env.local   # adjust if your facilitator/endpoint run elsewhere
npm run dev                  # http://localhost:3000
```

Landing is at `/`, demo at `/demo`.

## Design system

Pure-black canvas, self-luminous cyan/violet/magenta (the logo's convergence
palette). Tokens live in `tailwind.config.ts` (`conduit-*`) and `globals.css`
(gradients, `.panel`, `.btn-primary`, `.beam`, `.reveal`, etc.). Keep
everything on this system so landing + demo feel seamless.

## Adding the generated visuals

The landing has `<IllustrationSlot>` placeholders (hero, architecture,
delegation-chain). Generate each from the prompts in
[ILLUSTRATIONS.md](./ILLUSTRATIONS.md), drop the file in `public/images/`,
and swap the slot for an `<Image>` or `<video>`. The hero (`hero-flow`) and
the cascading-revoke animation (`delegation-chain`) are the two worth
animating.

## Demo: mock → real

`app/demo/page.tsx` currently runs on **mock state** so the full flow, the
panels, and every judging-lens beat (ask cleanly · execute-in-grant ·
boundary rejections · cascading revoke · receipt) are visible and animated.
Every mock action is marked `MOCK:`. The wiring to swap in:

1. **Connect** → viem `createWalletClient({ transport: custom(window.ethereum) })`.
2. **Grant** → `wallet_grantPermissions` (ERC-7715, `erc20-token-periodic`) +
   sign the EIP-7702 authorization. (`@metamask/delegation-toolkit`.)
3. **Run flow** → build the redelegation carrying `X402ReceiptEnforcer`,
   call the protected endpoint, then the facilitator `/verify` → `/settle`.
4. **Break-it buttons** → submit deliberately-invalid redemptions; surface
   the on-chain revert reason verbatim.
5. **Kill root** → `disableDelegation(root)` on the DelegationManager.

The facilitator + endpoint are separate services (`conduit-facilitator`,
`conduit-endpoint`); point `.env.local` at them.

## Mainnet (final demo)

Flip `NEXT_PUBLIC_CHAIN_ID=8453`, set the mainnet enforcer address, and point
the facilitator at its `oneshot-pl` backend. Nothing in the UI changes.

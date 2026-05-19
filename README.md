# Spike 1 — x402 V2 + ERC-7710 on Base Sepolia

## What we're testing

The x402 V2 spec defines three asset transfer methods. The third —
`erc7710` — uses MetaMask-style smart account delegations as the payment
authorization. Spec excerpt:

> Settlement is performed by calling `redeemDelegations` on the Delegation Manager.

We need to know **whether this is actually deployed and working today**, on
a testnet we can demo against. The spec describes the protocol, not the
state of any particular facilitator.

## Two-phase approach

### Phase A — Capability probe (15 minutes)

For each candidate facilitator, check `/supported` (or equivalent) and look
for `erc7710` in the list of asset transfer methods.

Candidates to probe (in order of preference):
1. **Coinbase CDP facilitator** — `https://x402.org/facilitator` (Base + Base Sepolia)
2. **ChaosChain** — `https://facilitator.chaoscha.in` (Base Sepolia, decentralized)
3. **PayAI** — see x402 ecosystem page
4. Anything else the x402 ecosystem page lists with Sepolia support

A single `curl` per facilitator is enough.

### Phase B — End-to-end paid call (2 hours)

If Phase A turns up a facilitator that lists `erc7710`:

1. Deploy a tiny x402-protected Express endpoint (`@x402/express` middleware).
   It returns the string "hello" for $0.01 USDC.
2. From a script, create a MetaMask Smart Account on Base Sepolia
   (via `@metamask/delegation-toolkit`), fund it with testnet USDC.
3. Create a delegation authorizing the facilitator to transfer up to
   0.01 USDC to the endpoint's payTo address, with appropriate caveats.
4. Make the paid request with `assetTransferMethod=erc7710`,
   `permissionContext` = the signed delegation.
5. Verify: 200 OK with payload, and on-chain a `redeemDelegations` tx that
   moved 0.01 USDC.

## Success criteria

- ✅ At least one hosted facilitator lists `erc7710` and accepts our flow
- 🟡 No hosted facilitator supports it, but the reference facilitator from
  `coinbase/x402` builds and runs locally against our test endpoint
- ❌ Neither works — escalate to the team, may need to revise approach

## Plan B if all facilitators are red

Self-host the reference facilitator from `coinbase/x402`. Expect ~1 day of
work. The reference impl is in the repo's `facilitator/` directory.

## Files

- `probe.sh` — Phase A capability probe
- `paid_call.ts` — Phase B end-to-end test
- `.env.example` — required configuration
- `RESULT.md` — fill in when done

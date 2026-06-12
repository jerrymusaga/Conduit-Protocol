# Conduit

Conduit is an open x402 facilitator and a family of on-chain caveat enforcers that
give an autonomous agent a budget it physically cannot misuse — even if the agent
is fully compromised.

It implements the x402 `erc7710` settlement method on MetaMask Smart Accounts,
adds custom caveats that bind each agent action to exactly what the user
authorized, and settles through 1Shot's Permissionless Relayer so the user pays
gas in USDC and never needs ETH.

The product is the facilitator plus the enforcer set. The dapp (ConduitPay) and the
resource server (endpoint) are a working harness that demonstrates the primitives
end to end.

## The core idea

A delegation is signed once. From that single signature, narrow agents can act
repeatedly, but only within bounds the user pinned on-chain at signing time. The
enforcer runs inside the Delegation Manager's `redeemDelegations` call, before the
action executes, and reverts the whole redemption if the action steps outside the
authorized envelope.

The guarantee is structural, not advisory. A hijacked agent cannot pay the wrong
recipient, overspend a cap, swap into a token you did not approve, deposit into a
venue you did not approve, accept a worse fill than your floor, or redirect any
proceeds. Every such attempt reverts on-chain and moves no funds.

## Enforcer family

Each enforcer guards one kind of action and is independently deployable and tested.

| Enforcer | Guards | Pins on-chain |
|---|---|---|
| `X402ReceiptEnforcer` | One x402 payment | token, recipient, max amount, one-shot intent hash |
| `X402SubscriptionEnforcer` | A recurring charge | exact amount, merchant, one charge per period |
| `SwapBoundsEnforcer` | One Uniswap v3 swap | router, fixed pair, input cap, slippage floor, recipient |
| `SwapAllowlistEnforcer` | A swap into a chosen set | a signed set of output tokens, each with its own floor |
| `ApproveBoundsEnforcer` | One ERC-20 approval | token, single spender, capped amount |
| `YieldAllowlistEnforcer` | One lending-pool deposit | a signed set of venues, one asset, cap, recipient |

The two allowlist enforcers are what make agent autonomy safe: the user signs a set
(of tokens, or of yield venues), and a scout agent picks the best member of that set
with live data — but the set the agent may choose from is exactly the set the user
signed. Resolving "the best token" or "the best APY" off-chain never grants reach
beyond the allowlist.

## Repository layout

```
src/                    Foundry contracts — the enforcer family
test/                   Unit and fork tests for every enforcer
script/                 Deploy scripts (one per enforcer)
conduit-facilitator/    Express + viem facilitator: /supported, /verify, /settle
conduit-endpoint/       x402 resource server that drives the facilitator
conduit-dapp/           Next.js app — ConduitPay (Pay, Subscriptions, Portfolio)
```

## How a bounded action settles

1. The user signs a root delegation carrying the relevant enforcer (the bounds).
2. A coordinator redelegates to a narrow task agent. It may narrow the bounds but
   the Delegation Manager's caveat-chain walking means it can never widen them.
3. The agent assembles the execution and submits it to the facilitator.
4. The facilitator settles via `redeemDelegations` through the 1Shot relayer.
   Approvals, the action, and a small USDC gas-fee leg ride one atomic batch.
5. The enforcer's `beforeHook` runs first. If the action is in bounds it emits a
   receipt event; otherwise it reverts and the whole batch is rolled back.

Because the batch is atomic, a single over-budget or out-of-bounds leg reverts the
entire transaction and spends nothing — there is no partial or wasted spend.

## ConduitPay (the dapp)

ConduitPay is a gated product surface over the primitives:

- Pay — a bounded swap. The user picks which curated tokens enter their signed set;
  a Venice-powered scout picks the best one for the goal and a trader executes the
  swap, all inside the signed allowlist.
- Yield — a bounded lending deposit. The user picks which curated Aave-V3 venues
  enter their signed set; a yield scout picks the best USDC supply APY and a
  depositor supplies into it, with the interest-bearing position credited to the
  user.
- Subscriptions — recurring, per-period charges bound by the subscription enforcer.
  Each charge delivers a live intelligence report, and a deliverable can hand off
  directly into a matching Pay or Yield action, closing the intel-to-action loop.
- Portfolio — every active permission with its decoded on-chain caveat, and a
  gasless kill switch (revoke without holding ETH).

Sign-in is via passkey (WebAuthn-PRF embedded wallet) or Privy. Both expose one
signer surface, so every feature works identically regardless of how the user
signed in.

## Deployed addresses (Base Sepolia)

| Contract | Address |
|---|---|
| X402ReceiptEnforcer | `0x111115259a41bd174c7C1f6B7eE36ec1Ab3CD5c1` |
| X402SubscriptionEnforcer | `0x9847Be9B20f23b2cb12C2D6C49B58772096E45eF` |
| SwapBoundsEnforcer | `0x1fd734c9c78e9c34238c2b5f4E936368727326f6` |
| SwapAllowlistEnforcer | `0xb95adacB74E981bcfB1e97B4d277E51A95753C8F` |
| ApproveBoundsEnforcer | `0xA86e7b31fA6a77186F09F36C06b2E7c5D3132795` |
| YieldAllowlistEnforcer | `0xDf4179e3b5A5B5D8Bfbd3fAe076D127bd96F3fa4` |
| DelegationManager (MetaMask v1.3.0) | `0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3` |
| USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |

## Build and test

Contracts (Foundry):

```
forge build
forge test
```

Fork tests require an RPC fork URL and are skipped without one. All unit tests run
offline.

Dapp (Next.js):

```
cd conduit-dapp
npm install
npm run build
npm run dev
```

## Deploying an enforcer

Each enforcer has a deploy script under `script/`. To deploy and verify on Base
Sepolia:

```
source .env
forge script script/DeployYieldAllowlist.s.sol:DeployYieldAllowlist \
  --rpc-url base_sepolia --broadcast --verify -vvv
```

For Base mainnet, use `--rpc-url base`. After deploying, set the corresponding
`NEXT_PUBLIC_*` address in the dapp environment (see `conduit-dapp/lib/config.ts`
for the full list of overridable addresses per chain).

Required environment variables: `DEPLOYER_PRIVATE_KEY`, `BASE_SEPOLIA_RPC_URL` or
`BASE_RPC_URL`, and `BASESCAN_API_KEY` for verification.

## Conventions

- Contracts are pinned to MetaMask delegation-framework v1.3.0, erc7579
  implementation v0.0.2, account-abstraction v0.7.0, Solidity 0.8.23.
- `redeemDelegations` returns no data in v1.3.0; the chain order is
  `[leaf, ..., root]` with the root authority set to all-`0xff`.
- The facilitator selects its relay backend by environment variable:
  `RELAY_BACKEND=viem-direct` or `oneshot-pl`.

## Security model

The blast radius of any compromise is bounded by which key leaks and by the caveats
on the delegation that key can redeem. A leaked task-agent key can only ever do the
one bounded thing its delegation permits; a leaked coordinator key can only narrow,
never widen. The root delegation can be revoked at any time — gaslessly — which
cascades to every task agent derived from it.

## License

MIT.

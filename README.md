# Conduit

Conduit is an open x402 facilitator and a family of on-chain caveat enforcers that
give an autonomous agent a budget it physically cannot misuse — even when the agent
is fully compromised.

It implements the x402 `erc7710` settlement method on MetaMask Smart Accounts,
adds custom `CaveatEnforcer` contracts that bind every agent action to exactly what
the user authorized, and settles through the 1Shot Permissionless Relayer so the
user pays gas in USDC and never holds ETH.

The product is the facilitator plus the enforcer set. The dapp (ConduitPay) and the
resource server are a working harness that exercises the primitives end to end on
Base mainnet.

## The core idea

A delegation is signed once. From that single signature, narrow agents act
repeatedly, but only within bounds the user pinned on-chain at signing time. Each
enforcer's `beforeHook` runs inside the Delegation Manager's `redeemDelegations`
call, before the guarded execution, and reverts the entire redemption if the
attempted action steps outside the authorized envelope.

The guarantee is structural, not advisory. A hijacked agent cannot pay the wrong
recipient, overspend a cap, swap into a token outside the signed set, deposit into
a venue outside the signed set, accept a worse fill than the floor, or redirect any
proceeds. Every such attempt reverts on-chain and moves no funds.

## Architecture

```
User account (EOA → MetaMask Smart Account via EIP-7702)
  │  signs ONE bounded root delegation (or grants it via ERC-7715)
  ▼
Coordinator (ephemeral in-session EOA)
  │  redelegates — may NARROW caveats, never widen
  ▼
Task agents  ──►  Conduit Facilitator  ──►  1Shot Permissionless Relayer
  (Venice)        /supported /verify /settle    redeemDelegations, gas in USDC, 7702
                  Ed25519 webhook status         │
                                                 ▼
                          MetaMask DelegationManager (unmodified)
                          + Conduit CaveatEnforcer.beforeHook  → revert if off-policy
```

```
src/                    Foundry contracts — the CaveatEnforcer family
test/                   Unit + fork tests for every enforcer (solc 0.8.23, via-IR)
script/                 Deploy scripts (per-enforcer + a one-shot DeployMainnet)
conduit-facilitator/    Express + viem facilitator (oneshot-pl relay backend)
conduit-endpoint/       x402 resource server (services catalog, 402 envelopes)
conduit-dapp/           Next.js app — ConduitPay (Pay, Yield, Subscriptions, Portfolio)
```

## Accounts and signers

Conduit needs the user's account to be a smart account so a delegation can be
redeemed against it. It reaches that state with **EIP-7702**: the EOA is designated
to MetaMask's `EIP7702StatelessDeleGatorImpl`
(`0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B`, same address on Base Sepolia and
mainnet), which makes the EOA execute as a MetaMask Smart Account while keeping its
address and ECDSA key. The 7702 authorization is either signed by the dapp and
bundled into the first `redeemDelegations` (embedded/passkey signers) or performed
natively by MetaMask during an ERC-7715 grant.

Three signer backends sit behind one interface — `useActiveWallet()`
(`conduit-dapp/lib/activeWallet.tsx`) — exposing `address`, `walletClient`,
`signAuthorization` (EIP-7702), and `signOut`, so every feature is signer-agnostic:

- **MetaMask extension** — granted via **ERC-7715 Advanced Permissions**
  (`wallet_requestExecutionPermissions`, `@metamask/smart-accounts-kit`). MetaMask
  signs a bounded `erc20-token-periodic` permission and performs the 7702 upgrade in
  its own UI. MetaMask deliberately blocks dapp-initiated raw delegation signatures
  for its accounts (anti-phishing), so ERC-7715 is the sanctioned path; Conduit uses
  it for the budget root and adds the custom caveat on the coordinator's leaf.
- **Privy embedded wallet** — email/social login mints an embedded EOA; the dapp
  signs the root delegation (`signTypedData_v4` of the DelegationManager EIP-712
  `Delegation`) and the 7702 authorization directly.
- **Passkey wallet (WebAuthn-PRF)** — a non-custodial secp256k1 wallet whose key is
  derived from the passkey's PRF extension and held inside an isolated, origin-locked
  iframe (`conduit-dapp/app/wallet-iframe`, `conduit-dapp/lib/passkey/*`). The key
  never touches the app context or any server; the iframe signs `signTypedData` and
  `signAuthorization` (7702) on request. Verified on Chrome/Android with PRF.

## The delegation model

- A **root** delegation is `delegate=coordinator, delegator=user, authority=ROOT
  (0xff…ff), caveats=[enforcer], salt`, signed under the DelegationManager EIP-712
  domain (`name="DelegationManager", version="1"`).
- A **leaf** is `delegate=relayer, delegator=coordinator, authority=hash(root)`,
  signed by the coordinator's in-memory key. The chain submitted to
  `redeemDelegations` is ordered `[leaf, …, root]`. v1.3.0 returns no data.
- The DelegationManager walks the caveat chain on redemption; a child can only
  **narrow** the parent's caveats, never widen them — so the user's root bounds hold
  no matter what the agents do.

Caveat terms are byte-packed (matching the contracts and fork tests). Examples:

```
X402ReceiptEnforcer     intentId(32) ++ token(20) ++ payTo(20) ++ maxAmount(16) ++ flags(1)
ERC20PeriodTransfer     token(20) ++ periodAmount(32) ++ periodDuration(32) ++ startTime(32)
SwapAllowlistEnforcer   router(20) ++ tokenIn(20) ++ maxIn(16) ++ recipient(20) ++ N(1)
                          ++ N×[ tokenOut(20) ++ minOut(16) ]
YieldAllowlistEnforcer  asset(20) ++ maxIn(16) ++ recipient(20) ++ N(1)
                          ++ N×[ pool(20) ++ minAmount(16) ]
X402SubscriptionEnforcer subscriptionId(32) ++ token(20) ++ recipient(20)
                          ++ amountPerPeriod(16) ++ periodDuration(4) ++ reserved(2)
```

## Settlement (1Shot, gas in USDC)

The facilitator's `oneshot-pl` backend settles through 1Shot's Permissionless
Relayer JSON-RPC:

- `relayer_send7710Transaction` submits the redemption. The payment carries `works[]`
  (the `[approve, action]` legs, e.g. `[USDC.approve(router), router.exactInputSingle]`
  or `[USDC.approve(pool), pool.supply]`) plus a `feeChain` — a bounded USDC fee leg
  that reimburses the relayer's gas in stablecoin. N agent payments plus the fee
  settle in **one** `redeemDelegations` batch (all-or-nothing: an over-budget leg
  reverts the whole transaction and spends nothing).
- The **EIP-7702 authorization** is passed in `authorizationList`, so the account
  upgrade is bundled into the same transaction through the relayer.
- `relayer_estimate7710Transaction` returns an exact, batch-aware fee quote used to
  size the fee leg.
- Settlement status is driven by 1Shot's **Ed25519-signed webhooks** (verified
  against the relayer's JWKS by `keyId`), with `relayer_getStatus` polling as a
  fallback. The facilitator forwards a clean `conduit.settlement` event to the seller.

The relayer's per-chain capabilities (`targetAddress` = the redeemer the work
delegation must name, `feeCollector` = where the fee leg pays) are fetched and warmed
at startup; the dapp reads them from the 402 envelope.

## Enforcer family

Every enforcer is a `CaveatEnforcer` (single-call, default-exec mode), independently
deployed, verified, and unit-tested.

| Enforcer | Guards | Pins on-chain |
|---|---|---|
| `X402ReceiptEnforcer` | one x402 payment | token, recipient, max amount, one-shot intent (paired with `IdEnforcer`) |
| `X402SubscriptionEnforcer` | a recurring charge | exact amount, merchant, one charge per period (on-chain period tracking) |
| `SwapBoundsEnforcer` | one Uniswap v3 swap | router, fixed pair, input cap, slippage floor, recipient |
| `SwapAllowlistEnforcer` | a swap into a chosen set | a signed set of output tokens, each with its own floor |
| `ApproveBoundsEnforcer` | one ERC-20 approval | token, single spender, capped amount (rides the same 1Shot batch) |
| `YieldAllowlistEnforcer` | one Aave-V3 `supply` | a signed set of venues, one asset, cap, `onBehalfOf` = user |

The two allowlist enforcers make agent autonomy safe: the user signs a *set* (of
tokens, or of yield venues, each with its own floor); a Venice scout reasons over
live data and picks the best member; the agent executes into it without the user
re-signing. The set the agent may choose from is exactly the set the user signed —
resolving "the best token" or "the best APY" never grants reach beyond the allowlist.

## Gasless revocation

Revocation is `DelegationManager.disableDelegation(root)`, gated `onlyDeleGator` so
only the user's account can send it; disabling a root cascades to every child
redelegation at once. Conduit runs it **gaslessly**: the relayer executes it from
the user's account, bounded by MetaMask's `AllowedTargetsEnforcer`
(`0x7F20f61b1f09b08D970938F6fa563634d65c4EeB`) + `AllowedMethodsEnforcer`
(`0x2c21fD0Cb9DC8445CB3fb0DC5E7Bb0Aca01842B5`) so the relayer may only call
`disableDelegation` and nothing else, reimbursed by a small USDC fee leg. A direct
on-chain transaction is the automatic fallback. So a fresh account with no ETH can
still kill its permissions.

## ConduitPay (the dapp)

A gated product surface over the primitives, with one signer abstraction:

- **Pay** — hire and pay an agent team (coordinator discovers specialists on the
  ERC-8004 Identity Registry, pays each via erc7710 redelegation, all in one atomic
  1Shot batch), or run a bounded swap into a user-selected token set.
- **Yield** — deposit USDC into the best APY across a user-selected set of Aave-V3
  venues (Aave, Seamless, ZeroLend on Base), via a gasless `[approve, supply]` batch.
- **Subscriptions** — fixed-price, one-merchant, once-per-period charges; each charge
  delivers a live Venice report, and a deliverable hands off into a matching Pay or
  Yield action (intel → action).
- **Portfolio** — every active permission with its decoded on-chain caveat and a
  gasless kill switch.

Signer support per flow: the **MetaMask extension** drives Pay (and Subscriptions)
via ERC-7715 Advanced Permissions; **Privy embedded** and **passkey** wallets drive
every flow (including swap/yield, whose allowlist enforcers are custom caveats on the
user-signed root). All are MetaMask Smart Accounts via the 7702 DeleGator.

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
| EIP7702StatelessDeleGatorImpl | `0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B` |
| USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |

## Deployed addresses (Base mainnet)

The full enforcer family is deployed and verified on Base mainnet.

**Conduit's custom caveat enforcers** (the moat — each deployed + verified on Basescan):

| Enforcer | Address (Basescan) |
|---|---|
| X402ReceiptEnforcer | [`0xF3D95eD5949970F483b11867b3b6509422a617AA`](https://basescan.org/address/0xF3D95eD5949970F483b11867b3b6509422a617AA#code) |
| X402SubscriptionEnforcer | [`0x177e5DC050Da4aCE6655B721E3a24B2A553B5F9F`](https://basescan.org/address/0x177e5DC050Da4aCE6655B721E3a24B2A553B5F9F#code) |
| SwapBoundsEnforcer | [`0x62DabA9aAD63B914Cba295B08a65263eEc401EE3`](https://basescan.org/address/0x62DabA9aAD63B914Cba295B08a65263eEc401EE3#code) |
| SwapAllowlistEnforcer | [`0x150933Eb33176B763c79609FF771d14D8Dc665c5`](https://basescan.org/address/0x150933Eb33176B763c79609FF771d14D8Dc665c5#code) |
| ApproveBoundsEnforcer | [`0x388084511a9a1891021ea6989b8A756D1561e0aA`](https://basescan.org/address/0x388084511a9a1891021ea6989b8A756D1561e0aA#code) |
| YieldAllowlistEnforcer | [`0xcBc69E09A6dfeCd503881DcAd595166f81836029`](https://basescan.org/address/0xcBc69E09A6dfeCd503881DcAd595166f81836029#code) |

**Framework + tokens:**

| Contract | Address (Basescan) |
|---|---|
| DelegationManager (MetaMask v1.3.0) | [`0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3`](https://basescan.org/address/0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3) |
| EIP7702StatelessDeleGatorImpl | [`0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B`](https://basescan.org/address/0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B) |
| USDC | [`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`](https://basescan.org/address/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913) |

**Agents (ERC-8004 Identity Registry).** The marketplace agents are registered on the
Base mainnet ERC-8004 Identity Registry
([`0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`](https://basescan.org/address/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432))
by registrant
([`0x131EC028Bb8Bd936A3416635777D905497F3D21f`](https://basescan.org/address/0x131EC028Bb8Bd936A3416635777D905497F3D21f)) —
**13 agents, IDs 55321–55336** (including the **Roaster**, agentId `55324`). Each
agent's on-chain `agentURI` points at its AgentCard, e.g.
[`/api/agent-card/roaster`](https://conduit-protocol.vercel.app/api/agent-card/roaster).

**Aave-V3 yield venues:**
[Aave](https://basescan.org/address/0xA238Dd80C259a72e81d7e4664a9801593F98d1c5) ·
[Seamless](https://basescan.org/address/0x8F44Fd754285aa6A2b8B9B97739B79746e0475a7) ·
[ZeroLend](https://basescan.org/address/0x766f21277087E18967c1b10bF602d8Fe56d0c671).

## Smart Accounts Kit usage

Conduit is built on `@metamask/smart-accounts-kit` (+ `/actions`, `/utils`). The user's
EOA becomes a MetaMask Smart Account via EIP-7702 (`EIP7702StatelessDeleGatorImpl`), and
every agent payment is a `DelegationManager.redeemDelegations` call gated by Conduit's
caveat enforcers.

### Advanced Permissions (ERC-7715)
- **Request** — `grantBudgetVia7715()` calls `requestExecutionPermissions` (the
  `erc7715ProviderActions` extension); MetaMask grants an `erc20-token-periodic`
  permission and performs the 7702 upgrade itself:
  [`conduit-dapp/lib/erc7715.ts#L30-L82`](https://github.com/jerrymusaga/Conduit-Protocol/blob/cd4d974/conduit-dapp/lib/erc7715.ts#L30-L82)
  (called from [`app/demo/page.tsx#L893`](https://github.com/jerrymusaga/Conduit-Protocol/blob/cd4d974/conduit-dapp/app/demo/page.tsx#L893)).
- **Redeem** — the granted `PermissionResponse.context` becomes the root of a
  redelegation chain that the relayer redeems via `redeemDelegations`. Client builds the
  redemption: [`conduit-dapp/lib/payment.ts#L111`](https://github.com/jerrymusaga/Conduit-Protocol/blob/cd4d974/conduit-dapp/lib/payment.ts#L111);
  facilitator simulates/executes it:
  [`conduit-facilitator/src/routes/verify.ts#L70-L82`](https://github.com/jerrymusaga/Conduit-Protocol/blob/cd4d974/conduit-facilitator/src/routes/verify.ts#L70-L82).

### Delegations
- **Create** — the user signs a root `Delegation` (`signDelegation`,
  `authority = ROOT_AUTHORITY`, bound by a caveat enforcer): budget root
  [`conduit-dapp/lib/grant.ts#L88-L150`](https://github.com/jerrymusaga/Conduit-Protocol/blob/cd4d974/conduit-dapp/lib/grant.ts#L88-L150);
  subscription root
  [`conduit-dapp/lib/subscription.ts#L190-L230`](https://github.com/jerrymusaga/Conduit-Protocol/blob/cd4d974/conduit-dapp/lib/subscription.ts#L190-L230).
- **Redeem** — `redeemDelegations` is simulated in
  [`conduit-facilitator/src/routes/verify.ts#L70-L82`](https://github.com/jerrymusaga/Conduit-Protocol/blob/cd4d974/conduit-facilitator/src/routes/verify.ts#L70-L82)
  and its args are built in
  [`conduit-facilitator/src/x402.ts#L118`](https://github.com/jerrymusaga/Conduit-Protocol/blob/cd4d974/conduit-facilitator/src/x402.ts#L118).

### Redelegation
- **Create** — a coordinator redelegates a narrowed leaf to the relayer
  (`authority = hashDelegation(parent)`, a child narrows-never-widens):
  [`conduit-dapp/lib/payment.ts#L284`](https://github.com/jerrymusaga/Conduit-Protocol/blob/cd4d974/conduit-dapp/lib/payment.ts#L284)
  (multi-hop leaf signing at
  [`L171-L208`](https://github.com/jerrymusaga/Conduit-Protocol/blob/cd4d974/conduit-dapp/lib/payment.ts#L171-L208)).

### x402
- **Server** — the facilitator advertises `erc7710` and runs verify/settle
  ([`supported.ts#L39-L46`](https://github.com/jerrymusaga/Conduit-Protocol/blob/cd4d974/conduit-facilitator/src/routes/supported.ts#L39-L46),
  [`verify.ts#L34`](https://github.com/jerrymusaga/Conduit-Protocol/blob/cd4d974/conduit-facilitator/src/routes/verify.ts#L34),
  [`settle.ts#L19`](https://github.com/jerrymusaga/Conduit-Protocol/blob/cd4d974/conduit-facilitator/src/routes/settle.ts#L19));
  the resource server returns the `402`:
  [`conduit-endpoint/src/index.ts#L345-L349`](https://github.com/jerrymusaga/Conduit-Protocol/blob/cd4d974/conduit-endpoint/src/index.ts#L345-L349).
- **Client (erc7710 asset transfer)** — runs `402 → X-PAYMENT → claim` and builds the
  intent-bound erc7710 redelegation that transfers USDC:
  [`conduit-dapp/lib/endpoint.ts#L157`](https://github.com/jerrymusaga/Conduit-Protocol/blob/cd4d974/conduit-dapp/lib/endpoint.ts#L157)
  + [`conduit-dapp/lib/payment.ts#L111`](https://github.com/jerrymusaga/Conduit-Protocol/blob/cd4d974/conduit-dapp/lib/payment.ts#L111).

## 1Shot API usage
- **Relayer JSON-RPC client** — `getCapabilities`, `getFeeData`, `send7710Transaction`,
  `send7710TransactionMultichain`, `estimate7710Transaction`, `getStatus`:
  [`conduit-facilitator/src/relayers/oneshotClient.ts#L130-L161`](https://github.com/jerrymusaga/Conduit-Protocol/blob/cd4d974/conduit-facilitator/src/relayers/oneshotClient.ts#L130-L161).
- **Settlement** — builds `works[]` + a bounded USDC `feeChain`, sizes the fee with
  `estimate7710Transaction`, submits via `send7710Transaction` (gas in USDC, 7702 in
  `authorizationList`):
  [`conduit-facilitator/src/relayers/oneshotPermissionless.ts`](https://github.com/jerrymusaga/Conduit-Protocol/blob/cd4d974/conduit-facilitator/src/relayers/oneshotPermissionless.ts).
- **Ed25519 webhook verification** (JWKS by `keyId`):
  [`conduit-facilitator/src/relayers/oneshotWebhook.ts`](https://github.com/jerrymusaga/Conduit-Protocol/blob/cd4d974/conduit-facilitator/src/relayers/oneshotWebhook.ts)
  + inbound handler
  [`conduit-facilitator/src/routes/relayerWebhook.ts`](https://github.com/jerrymusaga/Conduit-Protocol/blob/cd4d974/conduit-facilitator/src/routes/relayerWebhook.ts).

## Venice AI usage
- **Seller agents** (chat + web-search, reasoning, image, TTS, crypto-RPC) — the paid
  agents' generation:
  [`conduit-endpoint/src/venice.ts`](https://github.com/jerrymusaga/Conduit-Protocol/blob/cd4d974/conduit-endpoint/src/venice.ts)
  (chat `#L84`, crypto-RPC `#L125`, image `#L145`, TTS `#L171`, search `#L203`); per-role
  outputs incl. the **Roaster**:
  [`conduit-endpoint/src/index.ts`](https://github.com/jerrymusaga/Conduit-Protocol/blob/cd4d974/conduit-endpoint/src/index.ts).
- **Coordinator intelligence** (chat / image / STT):
  [`conduit-dapp/lib/venice-server.ts`](https://github.com/jerrymusaga/Conduit-Protocol/blob/cd4d974/conduit-dapp/lib/venice-server.ts).
- **Voice input (STT)**:
  [`conduit-dapp/app/api/transcribe/route.ts`](https://github.com/jerrymusaga/Conduit-Protocol/blob/cd4d974/conduit-dapp/app/api/transcribe/route.ts).
- **Team planning** (Venice picks the agent team):
  [`conduit-dapp/app/api/plan/route.ts`](https://github.com/jerrymusaga/Conduit-Protocol/blob/cd4d974/conduit-dapp/app/api/plan/route.ts).
- **Scout** (picks the best token/venue within a signed set):
  [`conduit-dapp/app/api/scout/route.ts`](https://github.com/jerrymusaga/Conduit-Protocol/blob/cd4d974/conduit-dapp/app/api/scout/route.ts)
  + [`conduit-dapp/app/api/yield-scout/route.ts`](https://github.com/jerrymusaga/Conduit-Protocol/blob/cd4d974/conduit-dapp/app/api/yield-scout/route.ts).

## Feedback
Detailed, balanced feedback for MetaMask, 1Shot, Venice, and the x402 / ERC-7710 spec —
**what we hit → why it cost time → a concrete suggestion** for each — is in
[`FEEDBACK.md`](https://github.com/jerrymusaga/Conduit-Protocol/blob/cd4d974/FEEDBACK.md).

## Social Media

Conduit's build was documented in public on X throughout the hackathon.

- **Conduit:** [@ConduitProtocol](https://x.com/ConduitProtocol)
- **Builder:** [@JerryMusaga](https://x.com/JerryMusaga)

**Build log (chronological):**

1. https://x.com/ConduitProtocol/status/2055280609132445820
2. https://x.com/ConduitProtocol/status/2056397273504903175
3. https://x.com/ConduitProtocol/status/2056748237873164679
4. https://x.com/ConduitProtocol/status/2057066557335810132
5. https://x.com/ConduitProtocol/status/2057848263169003740
6. https://x.com/JerryMusaga/status/2057888316096196688
7. https://x.com/ConduitProtocol/status/2058873242933146025
8. https://x.com/ConduitProtocol/status/2059006116215083088
9. https://x.com/ConduitProtocol/status/2060052391656050960
10. https://x.com/ConduitProtocol/status/2060079706469261761
11. https://x.com/ConduitProtocol/status/2061426516890657270
12. https://x.com/ConduitProtocol/status/2062951973687595017
13. https://x.com/ConduitProtocol/status/2064934228261744697
14. https://x.com/ConduitProtocol/status/2065825625621811477
15. https://x.com/ConduitProtocol/status/2066377699308847112
16. https://x.com/ConduitProtocol/status/2066472187884650814

## Build and test

Contracts (Foundry, solc 0.8.23, via-IR):

```
forge build
forge test          # unit suites run offline; *.fork.t.sol need an RPC fork URL
```

Dapp (Next.js):

```
cd conduit-dapp
npm install
npm run build
npm run dev
```

## Deploying enforcers

Per-enforcer scripts under `script/`, or the whole family in one broadcast with
`script/DeployMainnet.s.sol`:

```
source .env
forge script script/DeployMainnet.s.sol:DeployMainnet \
  --rpc-url base --broadcast --slow --verify -vvv
```

Use `--slow` — a 7702-delegated deployer hits the relayer's in-flight transaction
limit otherwise. After deploying, set the corresponding `NEXT_PUBLIC_*` addresses in
the dapp (see `conduit-dapp/lib/config.ts` for the per-chain list). Required env:
`DEPLOYER_PRIVATE_KEY`, `BASE_RPC_URL` / `BASE_SEPOLIA_RPC_URL`, `BASESCAN_API_KEY`.

## Conventions

- Pinned: delegation-framework v1.3.0, erc7579-implementation v0.0.2,
  account-abstraction v0.7.0, solc 0.8.23.
- `redeemDelegations` returns no data in v1.3.0; chain order `[leaf, …, root]`;
  `ROOT_AUTHORITY = bytes32(uint256.max)`.
- Length-check calldata before field checks in every enforcer (post-audit ordering).
- The facilitator's relay backend is `oneshot-pl` (1Shot Permissionless Relayer); the
  relayer URL is derived per chain (`.dev` testnet, `.com` mainnet) unless overridden.

## Security model

Blast radius is bounded by which key leaks and by the caveats on the delegation that
key can redeem. A leaked task-agent key can only ever perform the one bounded action
its leaf permits; a leaked coordinator key can only narrow, never widen, the user's
root; the root is revocable at any time — gaslessly — cascading to every child. The
custom-enforcer flows (swap, yield, subscription) keep the safety-critical bound on
the user-signed root, so even the coordinator cannot widen them.

Honest scope: EIP-3009 (`transferWithAuthorization`) is not ERC-7710 — Conduit
settles via `redeemDelegations` precisely so the caveat family is enforceable on
chain. MetaMask's ERC-7715 catalog covers token-spending permissions, so the
extension drives the budget/subscription flows; custom-enforcer execution (swap,
yield) is signed by an embedded or passkey wallet over the same MetaMask Smart
Account.

## License

MIT.

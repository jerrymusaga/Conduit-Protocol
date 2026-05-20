# Conduit — Facilitator

Open x402 facilitator implementing the `erc7710` asset transfer method.
The settle path is pluggable: **viem-direct** on testnet for development,
**1Shot Permissionless Relayer** on mainnet for the final demo. Flipping
between them is one env variable.

```
src/
├── index.ts                  Express entry point. Wires routes, selects backend.
├── config.ts                 Env validation (zod). Fails fast at startup.
├── chain.ts                  viem clients + per-chain framework addresses.
├── x402.ts                   x402 payment shapes + payload → redeem args.
├── jobs.ts                   In-memory settle-job tracking.
├── webhook.ts                Fire-and-forget status callbacks.
├── routes/
│   ├── supported.ts          GET  /supported  — advertises erc7710
│   ├── verify.ts             POST /verify     — simulate redeemDelegations
│   └── settle.ts             POST /settle, GET /jobs/:id
└── relayers/
    ├── types.ts              RelayBackend interface + shared types
    ├── index.ts              selectRelayBackend() — the env switch
    ├── viemDirect.ts         testnet backend (active)
    └── oneshotPermissionless.ts   mainnet backend (stub until ~day 19)
```

## Setup

```bash
npm install
cp .env.example .env
# fill in RELAYER_PRIVATE_KEY (a throwaway EOA with a little Base Sepolia ETH)
```

## Run

```bash
npm run dev          # tsx watch, hot reload
# or
npm start            # one-shot
```

On boot it prints the active network, relay backend, and enforcer address.

## The two phases

| Phase | `.env` | Settle path |
|---|---|---|
| **Dev / test** | `CHAIN_ID=84532`, `RELAY_BACKEND=viem-direct` | Funded EOA submits `redeemDelegations` directly. EIP-7702 auth (if present) is bundled into the same tx. |
| **Final demo** | `CHAIN_ID=8453`, `RELAY_BACKEND=oneshot-pl` | 1Shot Permissionless Relayer submits it; buyer pays gas in USDC. (Backend is a stub until the mainnet swap — see `relayers/oneshotPermissionless.ts`.) |

Nothing else changes between phases. Routes, verify logic, webhook contract,
and the dapp integration are identical.

## HTTP surface

### `GET /supported`
Advertises `erc7710` for the configured chain, plus Conduit-specific extras
(the `X402ReceiptEnforcer` address clients attach to redelegations).

### `POST /verify`
Body: `{ paymentPayload, paymentRequirements? }`. Simulates
`redeemDelegations` via `eth_call`. Returns `{ isValid, invalidReason }`.
No gas, no state change — per the spec, ERC-7710 verification is simulation.

### `POST /settle`
Body: same shape. Submits through the active relay backend. Returns
`{ success, jobId, status, transaction, relayBackend }`. Settlement is
async — the job advances in the background.

### `GET /jobs/:id`
Poll a settlement's status: `{ status, transaction, error, ... }`.
`status` ∈ `submitted | pending | confirmed | failed`.

### Webhooks
Set `WEBHOOK_URL` and every job transition is POSTed there. The 1Shot prize
criteria reward using relayer webhooks as the status source; on testnet we
fire the same callback ourselves so the consumer sees identical behavior.

## Test

```bash
npm test          # vitest run
```

Covers the x402 payload schema, the payload → redeem-args mapping (including
the EIP-7702 auth path), and the `/supported` route. Verify/settle against a
live chain are exercised manually:

```bash
# with the server running (npm run dev):
curl localhost:4400/supported | jq
curl -X POST localhost:4400/verify -H 'content-type: application/json' \
  -d @some-payment.json | jq
```

## Quick smoke test

```bash
curl localhost:4400/health | jq
# { "ok": true, "chainId": 84532, "network": "eip155:84532",
#   "relayBackend": "viem-direct", "receiptEnforcer": "0x1111..." }
```

## Notes for the mainnet swap (~day 19)

1. Deploy `X402ReceiptEnforcer` to Base mainnet, set `X402_RECEIPT_ENFORCER`.
2. Confirm Base mainnet DelegationManager + USDC addresses in `chain.ts`.
3. Implement `relayers/oneshotPermissionless.ts` against the live
   [1Shot relayer docs](https://1shotapi.com/docs/relayer/get-started/first-transaction).
4. Wire 1Shot's webhooks into `webhook.ts` as the status source.
5. Flip `CHAIN_ID=8453`, `RELAY_BACKEND=oneshot-pl`.

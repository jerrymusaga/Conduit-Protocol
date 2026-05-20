# Conduit — Protected Endpoint

An x402-protected resource server. It guards `GET /paid-data` behind a
payment: returns `402 Payment Required` advertising the `erc7710` method
and Conduit's facilitator, then serves the resource once the payment
verifies and settles.

```
src/
├── index.ts             Express entry. The /paid-data route + the x402 flow.
├── config.ts            Env validation (zod). Price → USDC base units.
├── chain.ts             Per-chain CAIP-2 + USDC address.
├── facilitatorClient.ts Talks to Conduit's facilitator (/supported, /verify, /settle).
└── paymentRequired.ts   Builds the 402 envelope.
```

## How it fits

```
buyer (dapp)                conduit-endpoint            conduit-facilitator
    |  GET /paid-data            |                            |
    | -------------------------> |                            |
    |  402 + PaymentRequirements |  (reads /supported once)   |
    | <------------------------- | <------------------------- |
    |  builds delegation,                                    |
    |  retries w/ X-PAYMENT      |                            |
    | -------------------------> |  POST /verify              |
    |                            | -------------------------> |
    |                            | <----- isValid ----------- |
    |                            |  POST /settle              |
    |                            | -------------------------> |
    |   200 + resource           | <----- jobId/tx ---------- |
    | <------------------------- |                            |
```

The endpoint never touches a chain directly. It delegates verification
(simulation) and settlement (relay) to the facilitator, which is where the
erc7710 + relay-backend logic lives.

## Setup

```bash
npm install
cp .env.example .env
# fill PAY_TO (any address you control — receives the USDC)
# FACILITATOR_URL defaults to http://localhost:4400 (the facilitator)
```

## Run

```bash
npm run dev      # tsx watch on :4500
```

Requires the facilitator running (default `http://localhost:4400`). The
endpoint reads the facilitator's `/supported` lazily on first request, so
it can start in any order.

## Try it

```bash
# 1. Request without payment → 402 envelope
curl -i localhost:4500/paid-data

# Inspect the envelope
curl -s localhost:4500/paid-data | jq '.accepts[0].extra'
# { assetTransferMethod: "erc7710", facilitator: "...", redeemer: "0x51A4...",
#   receiptEnforcer: "0x1111...", delegationManager: "0xdb9B..." }
```

The full paid flow (sending a real `X-PAYMENT`) needs a constructed,
signed delegation — that's the dapp's job. Until the dapp exists, exercise
the paid path with a hand-built payment payload (base64-encoded JSON) once
you have a valid delegation chain.

## Test

```bash
npm test
```

Covers the 402 envelope builder: erc7710 advertised, facilitator/redeemer/
enforcer present, price in base units, payTo + network correct.

## Notes for the mainnet swap

Nothing changes here. The endpoint is chain-agnostic — it reads the
redeemer + enforcer from whatever facilitator it points at. Point
`FACILITATOR_URL` at the mainnet-configured facilitator and set
`CHAIN_ID=8453`; the 402 envelope updates automatically.

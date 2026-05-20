// Runs before any test module imports config.ts. Provides a valid env so
// the startup validation in config.ts passes without process.exit.
//
// The private key is anvil's well-known test account #0 — public, throwaway,
// safe to commit. Never use it for anything real.
process.env.PORT ??= "4400";
process.env.CHAIN_ID ??= "84532";
process.env.RPC_URL ??= "https://sepolia.base.org";
process.env.X402_RECEIPT_ENFORCER ??=
  "0x111115259a41bd174c7C1f6B7eE36ec1Ab3CD5c1";
process.env.RELAY_BACKEND ??= "viem-direct";
process.env.RELAYER_PRIVATE_KEY ??=
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

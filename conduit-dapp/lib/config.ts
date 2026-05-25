/**
 * Browser-exposed config (all NEXT_PUBLIC_*). No secrets here.
 */

function required(key: string, value: string | undefined): string {
  if (!value) {
    // In dev we surface this loudly; in prod the build should have them set.
    console.warn(`[config] missing ${key} — using a fallback for dev`);
  }
  return value ?? "";
}

// Per-chain defaults so the dapp works with zero env config on Base Sepolia.
// Mainnet values are filled in before the mainnet demo (handoff step 5).
const CHAIN_DEFAULTS: Record<
  number,
  { rpcUrl: string; usdc: `0x${string}`; delegationManager: `0x${string}` }
> = {
  // Base Sepolia (dev)
  84532: {
    rpcUrl: "https://sepolia.base.org",
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    delegationManager: "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3",
  },
  // Base mainnet (final demo)
  8453: {
    rpcUrl: "https://mainnet.base.org",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    delegationManager: "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3",
  },
};

const chainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? "84532");
const defaults = CHAIN_DEFAULTS[chainId] ?? CHAIN_DEFAULTS[84532];

export const config = {
  chainId,
  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL ?? defaults.rpcUrl,
  facilitatorUrl:
    process.env.NEXT_PUBLIC_FACILITATOR_URL ?? "http://localhost:4400",
  endpointUrl:
    process.env.NEXT_PUBLIC_ENDPOINT_URL ?? "http://localhost:4500",
  receiptEnforcer: (process.env.NEXT_PUBLIC_X402_RECEIPT_ENFORCER ??
    "0x111115259a41bd174c7C1f6B7eE36ec1Ab3CD5c1") as `0x${string}`,
  // The ERC-20 the agent budget is denominated in (USDC). Used as the
  // `tokenAddress` of the ERC-7715 erc20-token-periodic permission and as
  // the bound token in the X402ReceiptEnforcer terms.
  usdc: (process.env.NEXT_PUBLIC_USDC ?? defaults.usdc) as `0x${string}`,
  // MetaMask DelegationManager. The grant response also returns this in
  // signerMeta.delegationManager; we keep a config default as a fallback and
  // for the redeem/kill-root paths.
  delegationManager: defaults.delegationManager,
} as const;

export type AppConfig = typeof config;

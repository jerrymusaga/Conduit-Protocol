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

// Per-chain framework addresses + USDC. All addresses are from
// @metamask/delegation-deployments v1.3.0; matches conduit-facilitator/chain.ts
// and the contracts test helpers/Constants.sol.
interface ChainDefaults {
  rpcUrl: string;
  usdc: `0x${string}`;
  delegationManager: `0x${string}`;
  /** ERC20PeriodTransferEnforcer — used in the root grant caveat. */
  erc20PeriodTransferEnforcer: `0x${string}`;
  /** IdEnforcer — used on the child redelegation for one-shot replay protection. */
  idEnforcer: `0x${string}`;
  /** TimestampEnforcer — bounds a delegation's validity window (subscription expiry). */
  timestampEnforcer: `0x${string}`;
  /** EIP7702StatelessDeleGatorImpl — what we designate the user EOA to. */
  eip7702Impl: `0x${string}`;
  /** SwapBoundsEnforcer — bounds a delegated DEX swap (trading agent). */
  swapBoundsEnforcer: `0x${string}`;
  /** Uniswap v3 SwapRouter02 — the swap venue the trading flow targets. */
  uniswapRouter: `0x${string}`;
  /** WETH (the demo's tokenOut for a USDC→WETH yield/trade). */
  weth: `0x${string}`;
  /** Block explorer base URL (no trailing slash) for tx/address links. */
  explorerUrl: string;
}

const CHAIN_DEFAULTS: Record<number, ChainDefaults> = {
  // Base Sepolia (dev)
  84532: {
    rpcUrl: "https://sepolia.base.org",
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    delegationManager: "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3",
    erc20PeriodTransferEnforcer: "0x474e3Ae7E169e940607cC624Da8A15Eb120139aB",
    idEnforcer: "0xC8B5D93463c893401094cc70e66A206fb5987997",
    timestampEnforcer: "0x1046bb45C8d673d4ea75321280DB34899413c069",
    eip7702Impl: "0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B",
    swapBoundsEnforcer: "0x1fd734c9c78e9c34238c2b5f4E936368727326f6",
    uniswapRouter: "0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4",
    weth: "0x4200000000000000000000000000000000000006",
    explorerUrl: "https://sepolia.basescan.org",
  },
  // Base mainnet (final demo). Addresses confirmed before the mainnet swap.
  8453: {
    rpcUrl: "https://mainnet.base.org",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    delegationManager: "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3",
    erc20PeriodTransferEnforcer: "0x474e3Ae7E169e940607cC624Da8A15Eb120139aB",
    idEnforcer: "0xC8B5D93463c893401094cc70e66A206fb5987997",
    timestampEnforcer: "0x1046bb45C8d673d4ea75321280DB34899413c069",
    eip7702Impl: "0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B",
    // Deploy SwapBoundsEnforcer to mainnet before the mainnet run, then set
    // NEXT_PUBLIC_SWAP_BOUNDS_ENFORCER. Placeholder = Sepolia addr until then.
    swapBoundsEnforcer: "0x1fd734c9c78e9c34238c2b5f4E936368727326f6",
    uniswapRouter: "0x2626664c2603336E57B271c5C0b26F421741e481",
    weth: "0x4200000000000000000000000000000000000006",
    explorerUrl: "https://basescan.org",
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
  // X402SubscriptionEnforcer — recurring intent-bound payments (Base Sepolia).
  subscriptionEnforcer: (process.env.NEXT_PUBLIC_X402_SUBSCRIPTION_ENFORCER ??
    "0x9847Be9B20f23b2cb12C2D6C49B58772096E45eF") as `0x${string}`,
  // The ERC-20 the agent budget is denominated in (USDC). Used as the
  // `tokenAddress` of the root erc20PeriodTransferEnforcer caveat and as the
  // bound token in the X402ReceiptEnforcer terms.
  usdc: (process.env.NEXT_PUBLIC_USDC ?? defaults.usdc) as `0x${string}`,
  delegationManager: defaults.delegationManager,
  erc20PeriodTransferEnforcer: defaults.erc20PeriodTransferEnforcer,
  idEnforcer: defaults.idEnforcer,
  timestampEnforcer: defaults.timestampEnforcer,
  eip7702Impl: defaults.eip7702Impl,
  // SwapBoundsEnforcer + the swap venue (Uniswap v3) for the trading agent.
  swapBoundsEnforcer: (process.env.NEXT_PUBLIC_SWAP_BOUNDS_ENFORCER ??
    defaults.swapBoundsEnforcer) as `0x${string}`,
  uniswapRouter: (process.env.NEXT_PUBLIC_UNISWAP_ROUTER ?? defaults.uniswapRouter) as `0x${string}`,
  weth: (process.env.NEXT_PUBLIC_WETH ?? defaults.weth) as `0x${string}`,
  // Hard fallback so a bad/missing chainId can never produce an "undefined/tx" link.
  explorerUrl: defaults.explorerUrl ?? "https://sepolia.basescan.org",
  // Privy: app id is required (from dashboard.privy.io). Client ID optional.
  privyAppId: process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "",
  privyClientId: process.env.NEXT_PUBLIC_PRIVY_CLIENT_ID ?? "",
} as const;

export type AppConfig = typeof config;

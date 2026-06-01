import {
  createPublicClient,
  http,
  type Address,
  type Chain,
  type PublicClient,
} from "viem";
import { base, baseSepolia } from "viem/chains";
import { config } from "./config.js";

/**
 * Per-chain framework addresses + viem clients. Everything chain-specific
 * is resolved here so the rest of the app is chain-agnostic.
 *
 * Framework addresses are from @metamask/delegation-deployments v1.3.0.
 * DelegationManager is the same logical contract on every chain but
 * deploys to different addresses; we pin the ones we actually target.
 */

interface ChainConfig {
  chain: Chain;
  caip2: string; // e.g. "eip155:84532"
  delegationManager: Address;
  usdc: Address;
}

const CHAINS: Record<number, ChainConfig> = {
  // Base Sepolia (dev)
  84532: {
    chain: baseSepolia,
    caip2: "eip155:84532",
    delegationManager: "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3",
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  },
  // Base mainnet (final demo) — DelegationManager + USDC addresses confirmed
  // before the mainnet swap; placeholders flagged in README until then.
  8453: {
    chain: base,
    caip2: "eip155:8453",
    delegationManager: "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  },
};

const current = CHAINS[config.chainId];
if (!current) {
  throw new Error(
    `Unsupported CHAIN_ID ${config.chainId}. Known: ${Object.keys(CHAINS).join(", ")}`
  );
}

export const chainConfig = current;

export const publicClient: PublicClient = createPublicClient({
  chain: current.chain,
  transport: http(config.rpcUrl),
});

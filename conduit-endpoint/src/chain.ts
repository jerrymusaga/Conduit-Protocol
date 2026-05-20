import { config } from "./config.js";

/**
 * Minimal per-chain constants the endpoint needs for the 402 envelope.
 * Must agree with the facilitator's chain config.
 */

interface ChainInfo {
  caip2: string;
  usdc: `0x${string}`;
}

const CHAINS: Record<number, ChainInfo> = {
  84532: {
    caip2: "eip155:84532",
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  },
  8453: {
    caip2: "eip155:8453",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  },
};

const info = CHAINS[config.chainId];
if (!info) {
  throw new Error(
    `Unsupported CHAIN_ID ${config.chainId}. Known: ${Object.keys(CHAINS).join(", ")}`
  );
}

export const chainInfo = info;

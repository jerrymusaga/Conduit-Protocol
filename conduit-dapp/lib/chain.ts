/**
 * Chain selection + a read-only public client. Everything chain-specific is
 * resolved from `config.chainId` so the rest of the dapp stays chain-agnostic
 * (mirrors the facilitator's chain.ts).
 */
import { createPublicClient, http, type Chain, type PublicClient } from "viem";
import { base, baseSepolia } from "viem/chains";
import { config } from "./config";

export const activeChain: Chain = config.chainId === 8453 ? base : baseSepolia;

export const publicClient: PublicClient = createPublicClient({
  chain: activeChain,
  transport: http(config.rpcUrl),
});

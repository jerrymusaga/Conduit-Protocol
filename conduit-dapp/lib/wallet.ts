/**
 * MetaMask connect via raw viem (no wagmi) — per the Conduit handoff.
 *
 * Creates a wallet client over the injected EIP-1193 provider, requests the
 * account, and makes sure the wallet is on the configured chain (Base Sepolia
 * in dev). The user's EOA is upgraded to a MetaMask Smart Account by MetaMask
 * itself during the ERC-7715 grant (EIP-7702) — see lib/erc7715.ts — so there
 * is nothing 7702-specific to do here.
 */
import { createWalletClient, custom, type WalletClient } from "viem";
import { activeChain, publicClient } from "./chain";
import { config } from "./config";

type Eip1193Provider = {
  request: (args: {
    method: string;
    params?: unknown[] | Record<string, unknown>;
  }) => Promise<unknown>;
};

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

export function getProvider(): Eip1193Provider {
  if (typeof window === "undefined" || !window.ethereum) {
    throw new Error(
      "No injected wallet found. Install MetaMask (Flask is required for ERC-7715 Advanced Permissions)."
    );
  }
  return window.ethereum;
}

export interface Connection {
  address: `0x${string}`;
  walletClient: WalletClient;
}

export async function connectWallet(): Promise<Connection> {
  const provider = getProvider();
  const walletClient = createWalletClient({
    chain: activeChain,
    transport: custom(provider),
  });

  const [address] = await walletClient.requestAddresses();
  if (!address) throw new Error("No account returned from the wallet");

  await ensureChain(walletClient);
  return { address, walletClient };
}

/** Switch the wallet to the configured chain, adding it first if unknown. */
async function ensureChain(walletClient: WalletClient): Promise<void> {
  const current = await walletClient.getChainId();
  if (current === config.chainId) return;
  try {
    await walletClient.switchChain({ id: config.chainId });
  } catch {
    // Unrecognized chain (EIP-1193 error 4902) → add it, then switch.
    await walletClient.addChain({ chain: activeChain });
    await walletClient.switchChain({ id: config.chainId });
  }
}

export { publicClient };

"use client";
/**
 * Auth + wallet + react-query providers for the dapp.
 *
 * ACTIVE signer: MetaMask Embedded Wallets (Web3Auth). One modal offers
 * email / GitHub (→ embedded wallet) AND external MetaMask. The embedded
 * wallet exposes its key (eth_private_key) so we can sign the EIP-7702
 * authorization client-side; external MetaMask can't, so the grant branches
 * on connector type (see app/demo/page.tsx).
 *
 * Nesting (load-bearing): Web3AuthProvider → QueryClientProvider → Web3Auth's
 * WagmiProvider. The WagmiProvider takes no config; it derives chains from
 * web3AuthOptions and exposes the connected wallet via standard wagmi hooks
 * (useAccount, useWalletClient).
 *
 * Privy (the previous signer) is commented out below, kept as a fallback in
 * case we revert.
 */
import { useState, type ReactNode } from "react";
import {
  Web3AuthProvider,
  type Web3AuthContextConfig,
} from "@web3auth/modal/react";
import { WagmiProvider } from "@web3auth/modal/react/wagmi";
import { WEB3AUTH_NETWORK, CHAIN_NAMESPACES } from "@web3auth/modal";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { config } from "@/lib/config";

const toHexChainId = (id: number) => `0x${id.toString(16)}`;

const web3AuthContextConfig: Web3AuthContextConfig = {
  web3AuthOptions: {
    clientId: config.web3authClientId,
    // Devnet network for the hackathon dev keys; flip to SAPPHIRE_MAINNET later.
    web3AuthNetwork: WEB3AUTH_NETWORK.SAPPHIRE_DEVNET,
    // Both chains available so the mainnet swap doesn't need a rebuild;
    // defaultChainId picks the one in use today.
    defaultChainId: toHexChainId(config.chainId),
    chains: [
      {
        chainNamespace: CHAIN_NAMESPACES.EIP155,
        chainId: toHexChainId(84532),
        rpcTarget: "https://sepolia.base.org",
        displayName: "Base Sepolia",
        blockExplorerUrl: "https://sepolia.basescan.org",
        ticker: "ETH",
        tickerName: "Ethereum",
        logo: "https://assets.web3auth.io/evm-chains/base.svg",
      },
      {
        chainNamespace: CHAIN_NAMESPACES.EIP155,
        chainId: toHexChainId(8453),
        rpcTarget: "https://mainnet.base.org",
        displayName: "Base",
        blockExplorerUrl: "https://basescan.org",
        ticker: "ETH",
        tickerName: "Ethereum",
        logo: "https://assets.web3auth.io/evm-chains/base.svg",
      },
    ],
  },
};

export function Providers({ children }: { children: ReactNode }) {
  // One QueryClient per app lifetime, created lazily in client state to survive
  // Next.js hydration without re-creating on every render.
  const [queryClient] = useState(() => new QueryClient());

  return (
    <Web3AuthProvider config={web3AuthContextConfig}>
      <QueryClientProvider client={queryClient}>
        <WagmiProvider>{children}</WagmiProvider>
      </QueryClientProvider>
    </Web3AuthProvider>
  );
}

/* ---------------------------------------------------------------------------
 * FALLBACK — Privy provider (previous signer). Restore by swapping the export
 * above for this and reinstalling @privy-io/react-auth + @privy-io/wagmi.
 *
 * import { PrivyProvider } from "@privy-io/react-auth";
 * import { WagmiProvider as PrivyWagmiProvider, createConfig } from "@privy-io/wagmi";
 * import { http } from "viem";
 * import { base, baseSepolia } from "viem/chains";
 * import { activeChain } from "@/lib/chain";
 *
 * const wagmiConfig = createConfig({
 *   chains: [baseSepolia, base],
 *   transports: { [baseSepolia.id]: http(), [base.id]: http() },
 * });
 *
 * export function Providers({ children }: { children: ReactNode }) {
 *   const [queryClient] = useState(() => new QueryClient());
 *   return (
 *     <PrivyProvider
 *       appId={config.privyAppId}
 *       clientId={config.privyClientId || undefined}
 *       config={{
 *         appearance: { theme: "dark", accentColor: "#00E5FF" },
 *         loginMethods: ["email", "github", "wallet"],
 *         embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" } },
 *         defaultChain: activeChain,
 *         supportedChains: [baseSepolia, base],
 *       }}
 *     >
 *       <QueryClientProvider client={queryClient}>
 *         <PrivyWagmiProvider config={wagmiConfig}>{children}</PrivyWagmiProvider>
 *       </QueryClientProvider>
 *     </PrivyProvider>
 *   );
 * }
 * ------------------------------------------------------------------------- */

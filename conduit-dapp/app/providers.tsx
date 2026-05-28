"use client";
/**
 * Auth + wallet + react-query providers for the dapp.
 *
 * Nesting order (load-bearing): PrivyProvider outermost (owns the auth context
 * + the connected wallets), QueryClientProvider next (wagmi v3 uses react-query
 * under the hood), and Privy's WagmiProvider innermost — it consumes the Privy
 * wallets and exposes them as wagmi's active account, so the rest of the dapp
 * can use standard hooks (useAccount, useWalletClient, usePublicClient).
 *
 * Privy gives us:
 *   - email / GitHub / passkey / external-wallet login in one modal
 *   - a viem walletClient (via wagmi) for the connected wallet
 *   - useSign7702Authorization (used in lib/grant.ts for the EIP-7702 upgrade
 *     required by the 1Shot Permissionless Relayer track)
 */
import { useState, type ReactNode } from "react";
import { PrivyProvider } from "@privy-io/react-auth";
import { WagmiProvider, createConfig } from "@privy-io/wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http } from "viem";
import { base, baseSepolia } from "viem/chains";
import { config } from "@/lib/config";
import { activeChain } from "@/lib/chain";

const wagmiConfig = createConfig({
  // Expose both chains so the mainnet swap (Phase B) doesn't require a rebuild
  // — `activeChain` controls which one we default to today.
  chains: [baseSepolia, base],
  transports: {
    [baseSepolia.id]: http(),
    [base.id]: http(),
  },
});

export function Providers({ children }: { children: ReactNode }) {
  // One QueryClient per app lifetime, created lazily in client state to survive
  // Next.js hydration without re-creating on every render.
  const [queryClient] = useState(() => new QueryClient());

  return (
    <PrivyProvider
      appId={config.privyAppId}
      clientId={config.privyClientId || undefined}
      config={{
        appearance: {
          theme: "dark",
          accentColor: "#00E5FF",
          showWalletLoginFirst: false,
          // Default wallet list — covers MetaMask + detected injected wallets.
          walletList: ["detected_wallets", "metamask", "wallet_connect"],
        },
        loginMethods: ["email", "github", "wallet"],
        embeddedWallets: {
          // Create an embedded wallet automatically for users who sign in via
          // email/GitHub (so they don't need to install anything).
          ethereum: { createOnLogin: "users-without-wallets" },
        },
        defaultChain: activeChain,
        supportedChains: [baseSepolia, base],
      }}
    >
      <QueryClientProvider client={queryClient}>
        <WagmiProvider config={wagmiConfig}>{children}</WagmiProvider>
      </QueryClientProvider>
    </PrivyProvider>
  );
}

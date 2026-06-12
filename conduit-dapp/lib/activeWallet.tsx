"use client";
/**
 * useActiveWallet — one signer surface over BOTH wallet backends so the product
 * (ConduitPay) doesn't care which you signed in with:
 *   - "privy"   → email / MetaMask / injected (via Privy + wagmi)
 *   - "passkey" → the isolated WebAuthn-PRF embedded wallet (lib/passkey)
 *
 * Both expose the same shape the Conduit lib functions need: address,
 * isConnected, a viem walletClient (signTypedData / signTransaction), and
 * signAuthorization (EIP-7702). Privy is the default; passkey is opt-in.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useAccount, useWalletClient } from "wagmi";
import { usePrivy, useSign7702Authorization, useWallets, getEmbeddedConnectedWallet } from "@privy-io/react-auth";
import { useSetActiveWallet } from "@privy-io/wagmi";
import type { WalletClient } from "viem";
import { config } from "./config";
import { getPasskeyWallet } from "./passkey/wallet";
import type { Eip7702Authorization } from "./payment";

export type WalletProviderKind = "privy" | "passkey";

export interface ActiveWallet {
  /** Which backend is active. */
  provider: WalletProviderKind;
  setProvider: (p: WalletProviderKind) => void;
  address?: `0x${string}`;
  isConnected: boolean;
  chainId?: number;
  /** viem walletClient for the active backend (undefined until connected). */
  walletClient?: WalletClient;
  /** Sign an EIP-7702 authorization (normalized to Eip7702Authorization). */
  signAuthorization: (args: { contractAddress: `0x${string}`; chainId: number; nonce: number }) => Promise<Eip7702Authorization>;
  /** Sign out of whichever backend is active (→ the app's auth gate closes). */
  signOut: () => Promise<void>;
  /** The passkey adapter (for the sign-in screen to drive create/unlock). */
  passkeyWallet: ReturnType<typeof getPasskeyWallet>;
}

const Ctx = createContext<ActiveWallet | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [provider, setProvider] = useState<WalletProviderKind>("privy");
  const [passkeyAddress, setPasskeyAddress] = useState<`0x${string}` | null>(null);

  // Privy / wagmi backend.
  const { address: wagmiAddress, isConnected: wagmiConnected, chainId: wagmiChainId } = useAccount();
  const { data: wagmiWalletClient } = useWalletClient({ chainId: config.chainId });
  const { signAuthorization: privySignAuth } = useSign7702Authorization();
  const { logout, authenticated } = usePrivy();
  const { wallets } = useWallets();
  const { setActiveWallet } = useSetActiveWallet();

  // Bind a restored/authenticated Privy session's wallet to wagmi HERE (not just in
  // the feature pages) so the gated /app route connects too. Without this, a stale
  // Privy session shows `authenticated` but wagmi stays disconnected → the gate
  // sticks on the sign-in screen and login() no-ops ("already logged in"). Prefer
  // the embedded wallet, then any EVM wallet (e.g. MetaMask).
  useEffect(() => {
    if (provider !== "privy" || !authenticated || wallets.length === 0) return;
    if (wagmiConnected && wagmiAddress) return; // already bound
    const embedded = getEmbeddedConnectedWallet(wallets);
    const evm = wallets.find((w) => w.chainId?.startsWith("eip155:"));
    const target = embedded ?? evm ?? wallets[0];
    if (target) void setActiveWallet(target).catch(() => {});
  }, [provider, authenticated, wallets, wagmiConnected, wagmiAddress, setActiveWallet]);

  const passkeyWallet = getPasskeyWallet();

  // Track the passkey wallet's unlocked address.
  useEffect(() => {
    const off = passkeyWallet.onEvent((e) => {
      if (e.type === "unlocked") setPasskeyAddress(e.address);
    });
    return off;
  }, [passkeyWallet]);

  const passkeyWalletClient = useMemo(() => {
    if (provider !== "passkey" || !passkeyAddress) return undefined;
    try {
      return passkeyWallet.getWalletClient();
    } catch {
      return undefined;
    }
  }, [provider, passkeyAddress, passkeyWallet]);

  const signOut = useCallback(async () => {
    if (provider === "passkey") {
      setPasskeyAddress(null); // forget the unlocked address (key stays in the iframe until reload)
    } else {
      await logout();
    }
  }, [provider, logout]);

  const value = useMemo<ActiveWallet>(() => {
    if (provider === "passkey") {
      return {
        provider, setProvider,
        address: passkeyAddress ?? undefined,
        isConnected: !!passkeyAddress,
        chainId: config.chainId,
        walletClient: passkeyWalletClient,
        signAuthorization: (args) => passkeyWallet.signAuthorization(args),
        signOut,
        passkeyWallet,
      };
    }
    return {
      provider, setProvider,
      address: wagmiAddress,
      isConnected: wagmiConnected && !!wagmiAddress,
      chainId: wagmiChainId,
      walletClient: wagmiWalletClient ?? undefined,
      signAuthorization: async ({ contractAddress, chainId, nonce }) => {
        const a = await privySignAuth(
          { contractAddress, chainId, nonce },
          wagmiAddress ? { address: wagmiAddress } : undefined
        );
        return {
          chainId: a.chainId,
          address: a.address as `0x${string}`,
          nonce: a.nonce,
          r: a.r,
          s: a.s,
          yParity: (a.yParity === 1 ? 1 : 0) as 0 | 1,
        };
      },
      signOut,
      passkeyWallet,
    };
  }, [provider, passkeyAddress, passkeyWalletClient, wagmiAddress, wagmiConnected, wagmiChainId, wagmiWalletClient, privySignAuth, signOut, passkeyWallet]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useActiveWallet(): ActiveWallet {
  const v = useContext(Ctx);
  if (!v) throw new Error("useActiveWallet must be used within <WalletProvider>");
  return v;
}

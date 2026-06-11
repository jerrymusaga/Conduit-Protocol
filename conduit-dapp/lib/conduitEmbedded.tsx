"use client";
/**
 * Tiny context so a feature page knows it's rendered INSIDE the ConduitPay shell
 * (which already provides nav + auth + the wallet chip) vs. standalone (/demo),
 * where it draws its own top bar + connect. The shell wraps its children in
 * <EmbeddedProvider>; pages read useConduitEmbedded() to hide their own chrome.
 */
import { createContext, useContext, type ReactNode } from "react";

const EmbeddedCtx = createContext(false);

export function EmbeddedProvider({ children }: { children: ReactNode }) {
  return <EmbeddedCtx.Provider value={true}>{children}</EmbeddedCtx.Provider>;
}

export function useConduitEmbedded(): boolean {
  return useContext(EmbeddedCtx);
}

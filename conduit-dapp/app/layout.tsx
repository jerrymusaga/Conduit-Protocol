import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Conduit — open x402 + ERC-7710 facilitator",
  description:
    "An open, self-hostable x402 facilitator built on MetaMask Smart Accounts. Agent-safe, intent-bound payments — gas paid in stablecoins via 1Shot.",
  openGraph: {
    title: "Conduit — open x402 + ERC-7710 facilitator",
    description:
      "Agent-safe, intent-bound payments on MetaMask Smart Accounts. Gas in stablecoins.",
    images: ["/images/conduit-logo.png"],
  },
  icons: { icon: "/images/conduit-logo.png" },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable}`}>
      <body className="font-sans">{children}</body>
    </html>
  );
}

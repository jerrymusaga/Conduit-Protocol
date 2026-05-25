import type { Config } from "tailwindcss";

// Conduit brand palette — cyan / violet / magenta on pure black.
// See memory: conduit-brand-design.
const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        conduit: {
          bg: "#000000",
          cyan: "#00E5FF",
          violet: "#7C3AED",
          magenta: "#EC4899",
          // surfaces
          panel: "#0a0a0f",
          border: "#1b1b24",
          muted: "#8a8a9a",
        },
      },
      fontFamily: {
        sans: ["var(--font-inter)", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
      boxShadow: {
        glow: "0 0 24px -4px rgba(0,229,255,0.35)",
        "glow-violet": "0 0 24px -4px rgba(124,58,237,0.4)",
      },
    },
  },
  plugins: [],
};

export default config;

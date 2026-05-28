/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  webpack: (config) => {
    // Privy's runtime references several optional peers (Farcaster mini-app,
    // pino-pretty, react-native storage). They're only used in environments
    // we don't target; tell webpack the missing modules resolve to nothing so
    // the client bundle compiles cleanly.
    config.resolve = config.resolve || {};
    config.resolve.alias = {
      ...(config.resolve.alias || {}),
      "@farcaster/mini-app-solana": false,
      "pino-pretty": false,
      "@react-native-async-storage/async-storage": false,
    };
    return config;
  },
};

export default nextConfig;

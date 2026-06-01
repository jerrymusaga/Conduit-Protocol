import "dotenv/config";
import { z } from "zod";

/**
 * Environment validation. Fails fast at startup with a clear message if
 * anything required for the selected relay backend is missing.
 */

const RELAY_BACKENDS = ["viem-direct", "oneshot-pl"] as const;
export type RelayBackendName = (typeof RELAY_BACKENDS)[number];

const hexAddress = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed 20-byte address");

const hexKey = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "must be a 0x-prefixed 32-byte private key");

const baseSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4400),
  CHAIN_ID: z.coerce.number().int().positive(),
  RPC_URL: z.string().url(),
  X402_RECEIPT_ENFORCER: hexAddress,
  RELAY_BACKEND: z.enum(RELAY_BACKENDS),
  WEBHOOK_URL: z.string().url().optional(),

  // viem-direct
  RELAYER_PRIVATE_KEY: hexKey.optional(),

  // oneshot-pl
  ONESHOT_RELAYER_URL: z.string().url().optional(),
  ONESHOT_GAS_TOKEN: z.string().optional(),
  // Public URL of THIS facilitator's inbound 1Shot webhook (POST /relayer-webhook).
  // When set, 1Shot POSTs Ed25519-signed status events here. Needs a public
  // tunnel in dev (e.g. ngrok). If unset, the backend polls relayer_getStatus.
  ONESHOT_WEBHOOK_URL: z.string().url().optional(),
});

const parsed = baseSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("✗ Invalid environment:");
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

const env = parsed.data;

// Backend-specific requirements that zod can't express conditionally.
if (env.RELAY_BACKEND === "viem-direct" && !env.RELAYER_PRIVATE_KEY) {
  console.error("✗ RELAY_BACKEND=viem-direct requires RELAYER_PRIVATE_KEY");
  process.exit(1);
}
if (env.RELAY_BACKEND === "oneshot-pl" && !env.ONESHOT_RELAYER_URL) {
  console.error("✗ RELAY_BACKEND=oneshot-pl requires ONESHOT_RELAYER_URL");
  process.exit(1);
}

export const config = {
  port: env.PORT,
  chainId: env.CHAIN_ID,
  rpcUrl: env.RPC_URL,
  receiptEnforcer: env.X402_RECEIPT_ENFORCER as `0x${string}`,
  relayBackend: env.RELAY_BACKEND,
  webhookUrl: env.WEBHOOK_URL,
  viemDirect: {
    relayerPrivateKey: env.RELAYER_PRIVATE_KEY as `0x${string}` | undefined,
  },
  oneshot: {
    relayerUrl: env.ONESHOT_RELAYER_URL,
    gasToken: env.ONESHOT_GAS_TOKEN ?? "USDC",
    webhookUrl: env.ONESHOT_WEBHOOK_URL,
  },
} as const;

export type Config = typeof config;

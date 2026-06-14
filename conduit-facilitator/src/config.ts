import "dotenv/config";
import { z } from "zod";

/**
 * Environment validation. Fails fast at startup with a clear message if
 * anything required is missing. Conduit settles through the 1Shot
 * Permissionless Relayer (gas paid in stablecoin).
 */

const hexAddress = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed 20-byte address");

const baseSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4400),
  CHAIN_ID: z.coerce.number().int().positive(),
  RPC_URL: z.string().url(),
  X402_RECEIPT_ENFORCER: hexAddress,
  // X402SubscriptionEnforcer — recurring intent-bound payments. Optional: if
  // unset, falls back to the deployed Base Sepolia address below.
  X402_SUBSCRIPTION_ENFORCER: hexAddress.optional(),
  WEBHOOK_URL: z.string().url().optional(),

  // 1Shot Permissionless Relayer. URL is optional — if unset, it's derived from
  // CHAIN_ID (.dev for Sepolia/Base Sepolia, .com for mainnets).
  ONESHOT_RELAYER_URL: z.string().url().optional(),
  ONESHOT_GAS_TOKEN: z.string().optional(),
  // Public URL of THIS facilitator's inbound 1Shot webhook (POST /relayer-webhook).
  // When set, 1Shot POSTs Ed25519-signed status events here. Needs a public
  // tunnel in dev (e.g. ngrok). If unset, the backend polls relayer_getStatus.
  ONESHOT_WEBHOOK_URL: z.string().url().optional(),

  // Where the per-wallet grants registry is persisted (JSON). Point this at a
  // mounted volume in production so it survives redeploys. Defaults to ./data.
  GRANTS_FILE: z.string().default("./data/grants.json"),

  // Where in-flight settlement jobs + their relayer TaskId links are persisted
  // (JSON), so a restart mid-settlement doesn't orphan a job (inbound webhooks
  // can still resolve it, and polling resumes). Same volume guidance as above.
  JOBS_FILE: z.string().default("./data/jobs.json"),
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

export const config = {
  port: env.PORT,
  chainId: env.CHAIN_ID,
  rpcUrl: env.RPC_URL,
  receiptEnforcer: env.X402_RECEIPT_ENFORCER as `0x${string}`,
  // Deployed X402SubscriptionEnforcer (Base Sepolia) — recurring payments.
  subscriptionEnforcer: (env.X402_SUBSCRIPTION_ENFORCER ??
    "0x9847Be9B20f23b2cb12C2D6C49B58772096E45eF") as `0x${string}`,
  relayBackend: "oneshot-pl" as const,
  webhookUrl: env.WEBHOOK_URL,
  grantsFile: env.GRANTS_FILE,
  jobsFile: env.JOBS_FILE,
  oneshot: {
    relayerUrl: env.ONESHOT_RELAYER_URL,
    gasToken: env.ONESHOT_GAS_TOKEN ?? "USDC",
    webhookUrl: env.ONESHOT_WEBHOOK_URL,
  },
} as const;

export type Config = typeof config;

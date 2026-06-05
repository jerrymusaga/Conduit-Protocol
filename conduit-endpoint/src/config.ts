import "dotenv/config";
import { parseUnits } from "viem";
import { z } from "zod";

/**
 * Env validation. Fails fast at startup with a clear message.
 */

const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed 20-byte address");

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(4500),
  CHAIN_ID: z.coerce.number().int().positive(),
  FACILITATOR_URL: z.string().url(),
  PAY_TO: address,
  PRICE_USDC: z.string().default("0.01"),
  RESOURCE_DESCRIPTION: z.string().default("Conduit protected demo resource"),
  // Venice API key (server-side Bearer). Optional: when unset, provider agents
  // fall back to canned outputs so the demo still runs. Never exposed to the dapp.
  VENICE_API_KEY: z.string().optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("✗ Invalid environment:");
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

const env = parsed.data;

// USDC has 6 decimals. Convert the human price into base units once.
const priceBaseUnits = parseUnits(env.PRICE_USDC, 6);

export const config = {
  port: env.PORT,
  chainId: env.CHAIN_ID,
  facilitatorUrl: env.FACILITATOR_URL.replace(/\/$/, ""),
  payTo: env.PAY_TO as `0x${string}`,
  priceUsdc: env.PRICE_USDC,
  priceBaseUnits, // bigint
  resourceDescription: env.RESOURCE_DESCRIPTION,
  veniceApiKey: env.VENICE_API_KEY,
} as const;

export type Config = typeof config;

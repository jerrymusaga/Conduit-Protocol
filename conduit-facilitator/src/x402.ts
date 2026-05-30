import { z } from "zod";
import type { Hex } from "viem";
import type { Eip7702Authorization, RelaySubmitParams } from "./relayers/types.js";

/**
 * x402 payment shapes for the erc7710 asset transfer method, plus helpers
 * to turn a payment payload into DelegationManager.redeemDelegations args.
 *
 * The facilitator HTTP surface follows the x402 V2 facilitator API:
 *   POST /verify   { x402Version, paymentPayload, paymentRequirements }
 *   POST /settle   { x402Version, paymentPayload, paymentRequirements }
 */

const hex = z.string().regex(/^0x[0-9a-fA-F]*$/, "must be 0x-prefixed hex");
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be an address");

const eip7702AuthorizationSchema = z.object({
  chainId: z.number().int(),
  address: address,
  nonce: z.number().int().nonnegative(),
  r: hex,
  s: hex,
  yParity: z.union([z.literal(0), z.literal(1)]),
});

/** The erc7710-specific payment payload. */
const erc7710PayloadSchema = z.object({
  delegationManager: address,
  // ABI-encoded delegation chain (root + redelegations). Opaque hex.
  permissionContext: hex,
  delegator: address,
  // ERC-7579 execution mode. Defaults to single-call default-exec.
  mode: hex.optional(),
  // Packed (target, value, callData) for the execution being authorized.
  executionCallData: hex,
  // Optional EIP-7702 authorization to bundle (mainnet flow).
  authorization: eip7702AuthorizationSchema.optional(),
});

export const paymentPayloadSchema = z.object({
  x402Version: z.number().int(),
  scheme: z.string(),
  network: z.string(),
  payload: erc7710PayloadSchema,
});

/** Optional descriptive labels for the operations-console event feed. */
export const eventMetaSchema = z
  .object({
    service: z.string().optional(),
    agent: z.string().optional(),
    resource: z.string().optional(),
    amount: z.string().optional(),
    correlationId: z.string().optional(),
  })
  .optional();

export const facilitatorRequestSchema = z.object({
  x402Version: z.number().int().optional(),
  paymentPayload: paymentPayloadSchema,
  // paymentRequirements is echoed by callers; we don't strictly need it for
  // erc7710 verification (simulation is self-contained), so accept anything.
  paymentRequirements: z.unknown().optional(),
  // Conduit extension: labels for the live console feed (who/what is paying).
  meta: eventMetaSchema,
});

export type PaymentPayload = z.infer<typeof paymentPayloadSchema>;
export type FacilitatorRequest = z.infer<typeof facilitatorRequestSchema>;

const ZERO_MODE = ("0x" + "00".repeat(32)) as Hex;

/**
 * Convert a single erc7710 payment payload into the array-shaped args that
 * DelegationManager.redeemDelegations expects (one-element arrays for a
 * single-chain redemption).
 */
export function toRelayParams(p: PaymentPayload): RelaySubmitParams {
  const payload = p.payload;
  return {
    permissionContexts: [payload.permissionContext as Hex],
    modes: [(payload.mode ?? ZERO_MODE) as Hex],
    executionCallDatas: [payload.executionCallData as Hex],
    authorization: payload.authorization as Eip7702Authorization | undefined,
  };
}

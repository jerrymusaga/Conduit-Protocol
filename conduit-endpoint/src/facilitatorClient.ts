import { config } from "./config.js";

/**
 * Thin client for Conduit's facilitator. The endpoint uses it to:
 *   - learn the facilitator's capabilities (redeemer, enforcer) at startup
 *   - verify an incoming payment (simulation)
 *   - settle a verified payment (relay submission)
 */

export interface ConduitCapabilities {
  network: string;
  receiptEnforcer: `0x${string}`;
  /** X402SubscriptionEnforcer — recurring intent-bound payments. */
  subscriptionEnforcer: `0x${string}`;
  delegationManager: `0x${string}`;
  redeemer: `0x${string}` | null;
  relayBackend: string;
  /** oneshot-pl only: where the buyer pays the relayer's gas fee. */
  feeCollector?: `0x${string}` | null;
}

export interface VerifyResult {
  isValid: boolean;
  invalidReason: string | null;
}

export interface SettleResult {
  success: boolean;
  jobId?: string;
  status?: string;
  transaction?: string | null;
  error?: string | null;
}

/** Fetch /supported and pull out the Conduit-specific capability block. */
export async function fetchCapabilities(): Promise<ConduitCapabilities> {
  const res = await fetch(`${config.facilitatorUrl}/supported`);
  if (!res.ok) {
    throw new Error(`facilitator /supported returned ${res.status}`);
  }
  const json = (await res.json()) as {
    kinds: Array<{
      network: string;
      extra?: {
        assetTransferMethods?: string[];
        conduit?: {
          receiptEnforcer: `0x${string}`;
          subscriptionEnforcer: `0x${string}`;
          delegationManager: `0x${string}`;
          redeemer: `0x${string}` | null;
          relayBackend: string;
          feeCollector?: `0x${string}` | null;
        };
      };
    }>;
  };

  const kind = json.kinds.find((k) =>
    k.extra?.assetTransferMethods?.includes("erc7710")
  );
  if (!kind?.extra?.conduit) {
    throw new Error(
      "facilitator does not advertise erc7710 with a conduit capability block"
    );
  }

  return { network: kind.network, ...kind.extra.conduit };
}

/** POST /verify — returns whether the payment would settle. */
export async function verify(facilitatorRequest: unknown): Promise<VerifyResult> {
  const res = await fetch(`${config.facilitatorUrl}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(facilitatorRequest),
  });
  return (await res.json()) as VerifyResult;
}

/** POST /settle — submits the redemption through the facilitator's relay. */
export async function settle(facilitatorRequest: unknown): Promise<SettleResult> {
  const res = await fetch(`${config.facilitatorUrl}/settle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(facilitatorRequest),
  });
  return (await res.json()) as SettleResult;
}

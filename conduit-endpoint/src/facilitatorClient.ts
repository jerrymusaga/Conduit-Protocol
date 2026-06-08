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
  /** Live gas-fee estimate (USDC atoms); buyer sizes the fee cap to it. */
  feeEstimate?: string | null;
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
          feeEstimate?: string | null;
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

export interface JobState {
  status: string; // "submitted" | "pending" | "confirmed" | "failed"
  transaction?: string | null;
  error?: string | null;
}

/** GET /jobs/:id — the current state of an async settlement job. */
export async function getJob(jobId: string): Promise<JobState | null> {
  try {
    const res = await fetch(`${config.facilitatorUrl}/jobs/${jobId}`);
    if (!res.ok) return null;
    const b = (await res.json()) as { status?: string; transaction?: string | null; error?: string | null };
    if (!b.status) return null;
    return { status: b.status, transaction: b.transaction ?? null, error: b.error ?? null };
  } catch {
    return null;
  }
}

/**
 * Block until an async settlement reaches a terminal state. Settlement via 1Shot
 * is async (accepted first, mines out of band), so callers that must NOT act
 * until the payment actually settled — e.g. the atomic commission, which only
 * delivers work once the batch is on-chain — poll the job to confirmation.
 */
export async function waitForSettlement(jobId: string, timeoutMs = 90_000): Promise<JobState> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const job = await getJob(jobId);
    if (!job) continue;
    if (job.status === "confirmed" || job.status === "failed") return job;
  }
  return { status: "timeout", error: "the payment did not confirm in time" };
}

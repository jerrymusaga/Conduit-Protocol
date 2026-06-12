/**
 * Client for the facilitator's grants registry — the index behind /portfolio.
 *
 * ERC-7715 grants are signed off-chain, so there's no "created" event to scan
 * and the enforcer events key by delegationHash (not the user account). We
 * register each grant here on creation so a wallet can later enumerate every
 * permission it signed (across devices). LIVE state (budget left, period,
 * status) is still read on-chain — this is just the per-wallet index.
 *
 * Best-effort: registration failures are swallowed (logged) so they never block
 * the grant/charge flow; the portfolio simply won't list an unregistered grant.
 */
import type { Hex } from "viem";
import { config } from "./config";

export type GrantKind = "budget" | "subscription" | "swap" | "yield";

export interface GrantRecord {
  id: string;
  user: string;
  kind: GrantKind;
  label: string;
  /** The originating prompt the user authorised this for. */
  prompt?: string;
  coordinator?: string;
  token?: string;
  /** Base units: budget = period cap; subscription = amount per period. */
  amount?: string;
  /** Absolute expiry (unix seconds). 0 / undefined = no expiry. */
  expiry?: number;
  /** Subscription cadence, or the budget's rolling period window (seconds). */
  periodSeconds?: number;
  /** keccak of the root delegation (subscription state key). */
  delegationHash?: string;
  enforcer?: string;
  merchant?: string;
  context?: string;
  createdAt: number;
  revokedAt?: number;
}

export type GrantInput = Omit<GrantRecord, "createdAt"> & { createdAt?: number };

/** Register a grant the user just signed. Returns the stored record, or null on
 *  failure (never throws — registration must not break the grant flow). */
export async function registerGrant(input: GrantInput): Promise<GrantRecord | null> {
  try {
    const res = await fetch(`${config.facilitatorUrl}/grants`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { grant?: GrantRecord };
    return j.grant ?? null;
  } catch (e) {
    console.warn("[grants] register failed:", e instanceof Error ? e.message : e);
    return null;
  }
}

/** Every grant a wallet signed, newest first. */
export async function listGrants(user: Hex): Promise<GrantRecord[]> {
  try {
    const res = await fetch(`${config.facilitatorUrl}/grants?user=${user}`);
    if (!res.ok) return [];
    const j = (await res.json()) as { grants?: GrantRecord[] };
    return j.grants ?? [];
  } catch (e) {
    console.warn("[grants] list failed:", e instanceof Error ? e.message : e);
    return [];
  }
}

/** Mark a grant revoked (after the user ran disableDelegation on-chain). */
export async function markGrantRevoked(id: string, user: Hex): Promise<boolean> {
  try {
    const res = await fetch(`${config.facilitatorUrl}/grants/${id}/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

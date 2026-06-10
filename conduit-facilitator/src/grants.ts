import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";

/**
 * The grants registry — the per-wallet record of every ERC-7715 permission a
 * user signed (budget grants from /demo, subscriptions from /subscription).
 *
 * Why this exists: ERC-7715 grants are signed OFF-CHAIN, so there is no
 * "created" event to scan, and the enforcer events key by delegationHash /
 * coordinator — NOT the user's smart account. So "show me every permission
 * wallet X granted" cannot be answered from the chain alone. The dapp registers
 * each grant here on creation; the /portfolio page enumerates them per wallet
 * and reads LIVE state (budget meter, period, status) on-chain.
 *
 * Persisted to a JSON file (GRANTS_FILE) so the registry survives a redeploy and
 * a device switch. Single-instance / hackathon scale; a production multi-instance
 * deploy would back this with a real DB.
 */

export type GrantKind = "budget" | "subscription" | "swap";

export interface GrantRecord {
  /** Stable id — the delegationHash if the client has it, else a uuid. */
  id: string;
  /** The user's smart-account address (lowercased) this grant belongs to. */
  user: string;
  kind: GrantKind;
  /** Human label, e.g. the prompt summary or the subscription name. */
  label: string;
  /** The originating prompt the user authorised this for (verbatim). */
  prompt?: string;
  /** The coordinator/session account the grant delegates to (budget grants). */
  coordinator?: string;
  /** ERC-20 token address the budget/charge is denominated in. */
  token?: string;
  /** Base-unit amount: budget = period cap; subscription = amount per period. */
  amount?: string;
  /** Absolute expiry (unix seconds). 0 / undefined = no expiry. */
  expiry?: number;
  /** Subscription cadence, or the budget's rolling period window (seconds). */
  periodSeconds?: number;
  /** keccak of the root delegation = the enforcer's on-chain state key
   *  (needed to read subscription period state). */
  delegationHash?: string;
  /** The on-chain enforcer bounding this grant. */
  enforcer?: string;
  /** Subscription payee (the bound merchant). */
  merchant?: string;
  /** The signed delegation context (stringified) — lets the portfolio revoke
   *  from any device by replaying disableDelegation. Optional. */
  context?: string;
  createdAt: number;
  /** Set when the user revoked (disableDelegation) — surfaced as status. */
  revokedAt?: number;
}

const GRANTS_FILE = config.grantsFile;

/** user (lowercased) → their grants, newest first. */
const byUser = new Map<string, GrantRecord[]>();
let allCount = 0;

function load(): void {
  try {
    if (!existsSync(GRANTS_FILE)) return;
    const raw = readFileSync(GRANTS_FILE, "utf8").trim();
    if (!raw) return;
    const list = JSON.parse(raw) as GrantRecord[];
    for (const g of list) {
      const u = g.user.toLowerCase();
      const arr = byUser.get(u) ?? [];
      arr.push(g);
      byUser.set(u, arr);
      allCount++;
    }
    for (const arr of byUser.values()) arr.sort((a, b) => b.createdAt - a.createdAt);
    console.log(`[grants] loaded ${allCount} grant(s) from ${GRANTS_FILE}`);
  } catch (err) {
    console.warn(`[grants] could not load ${GRANTS_FILE}:`, err instanceof Error ? err.message : err);
  }
}

function persist(): void {
  try {
    const all: GrantRecord[] = [];
    for (const arr of byUser.values()) all.push(...arr);
    mkdirSync(dirname(GRANTS_FILE), { recursive: true });
    // Atomic write: tmp + rename, so a crash mid-write can't corrupt the file.
    const tmp = `${GRANTS_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2), "utf8");
    renameSync(tmp, GRANTS_FILE);
  } catch (err) {
    console.warn(`[grants] could not persist ${GRANTS_FILE}:`, err instanceof Error ? err.message : err);
  }
}

load();

/** Register (or upsert by id) a grant. Returns the stored record. */
export function registerGrant(
  input: Omit<GrantRecord, "id" | "createdAt"> & { id?: string; createdAt?: number }
): GrantRecord {
  const user = input.user.toLowerCase();
  const id = input.id || randomUUID();
  const record: GrantRecord = { ...input, id, user, createdAt: input.createdAt ?? Date.now() };
  const arr = byUser.get(user) ?? [];
  const existing = arr.findIndex((g) => g.id === id);
  const prev = existing >= 0 ? arr[existing] : undefined;
  if (prev) {
    // Preserve a prior revokedAt + createdAt on re-register.
    record.createdAt = prev.createdAt;
    record.revokedAt = record.revokedAt ?? prev.revokedAt;
    arr[existing] = record;
  } else {
    arr.unshift(record);
    allCount++;
  }
  byUser.set(user, arr);
  persist();
  return record;
}

/** Every grant a wallet signed, newest first. */
export function listGrants(user: string): GrantRecord[] {
  return byUser.get(user.toLowerCase()) ?? [];
}

/** Mark a grant revoked (the user ran disableDelegation on-chain). */
export function revokeGrant(id: string, user: string): GrantRecord | undefined {
  const arr = byUser.get(user.toLowerCase());
  const rec = arr?.find((g) => g.id === id);
  if (!rec) return undefined;
  rec.revokedAt = Date.now();
  persist();
  return rec;
}

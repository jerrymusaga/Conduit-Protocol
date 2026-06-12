/**
 * Talks to the Conduit demo seller (conduit-endpoint). The dapp drives the x402
 * exchange: GET → 402 (read requirements) → re-GET with X-PAYMENT → 200 (asset).
 * The endpoint internally calls the facilitator's /verify + /settle.
 */
import { config } from "./config";

const RESOURCE_PATH = "/paid-data";

/** A service in the endpoint's x402 catalog (GET /services). */
export interface CatalogService {
  id: string;
  label: string;
  description: string;
  kind: "image" | "audio" | "text" | "data" | "subscription";
  priceUsdc: string;
  priceBaseUnits: string;
  /** Relative resource path, e.g. "/services/venice-image". */
  resource: string;
}

/** Subscription terms a recurring service advertises in its 402 envelope. */
export interface SubscriptionRequirements {
  /** X402SubscriptionEnforcer address the buyer binds the root grant to. */
  enforcer: `0x${string}`;
  /** Off-chain subscription id (bytes32), packed into the enforcer terms. */
  subscriptionId: `0x${string}`;
  /** Billing period length in seconds (the cadence). */
  periodSeconds: number;
  /** Exact charge per period, in token base units (string). */
  amountPerPeriod: string;
  /** Optional seller-offered cadence menu — the buyer may pick + sign one. */
  tiers?: { periodSeconds: number; amountPerPeriod: string; label: string }[];
}

/** Fetch the seller's service catalog. */
export async function fetchCatalog(): Promise<CatalogService[]> {
  const res = await fetch(`${config.endpointUrl}/services`);
  if (!res.ok) throw new Error(`catalog fetch failed: HTTP ${res.status}`);
  const body = (await res.json()) as { services: CatalogService[] };
  return body.services;
}

/** The bits of the x402 402-envelope (`accepts[0]`) the dapp needs to pay. */
export interface PaymentRequirements {
  scheme: string;
  network: string;
  /** Price in token base units (string). */
  maxAmountRequired: string;
  resource: string;
  payTo: `0x${string}`;
  asset: `0x${string}`;
  delegationManager: `0x${string}`;
  receiptEnforcer: `0x${string}`;
  /** Who submits redeemDelegations — must be the leaf delegate. */
  redeemer: `0x${string}` | null;
  /** Catalog service id this 402 is for (when paying a catalog service). */
  service?: string;
  /** "subscription" | "one-shot" — which enforcer binds this payment. */
  paymentKind?: "subscription" | "one-shot";
  /** Present when paymentKind === "subscription". */
  subscription?: SubscriptionRequirements | null;
  /** Active relay backend ("viem-direct" | "oneshot-pl"). */
  relayBackend?: string;
  /** oneshot-pl only: where the buyer pays the relayer's gas fee. */
  feeCollector?: `0x${string}` | null;
  /** Live gas-fee estimate (USDC atoms); the buyer caps the fee leg at estimate × buffer. */
  feeEstimate?: string | null;
}

/**
 * GET a protected resource with no payment → parse the 402 requirements.
 * `path` defaults to the legacy /paid-data; pass a catalog service's resource
 * path (e.g. "/services/venice-image") to pay for a specific service.
 */
export async function fetch402(path: string = RESOURCE_PATH): Promise<PaymentRequirements> {
  const res = await fetch(`${config.endpointUrl}${path}`);
  if (res.status !== 402) {
    throw new Error(`expected 402 Payment Required, got HTTP ${res.status}`);
  }
  const body = await res.json();
  const accept = body?.accepts?.[0];
  if (!accept) throw new Error("402 envelope missing accepts[0]");
  const extra = accept.extra ?? {};
  return {
    scheme: accept.scheme,
    network: accept.network,
    maxAmountRequired: accept.maxAmountRequired,
    resource: accept.resource,
    payTo: accept.payTo,
    asset: accept.asset,
    delegationManager: extra.delegationManager,
    receiptEnforcer: extra.receiptEnforcer,
    redeemer: extra.redeemer ?? null,
    service: extra.service,
    paymentKind: extra.paymentKind ?? "one-shot",
    subscription: extra.subscription ?? null,
    relayBackend: extra.relayBackend,
    feeCollector: extra.feeCollector ?? null,
    feeEstimate: extra.feeEstimate ?? null,
  };
}

export interface ClaimResult {
  ok: boolean;
  status: number;
  data?: unknown;
  settlement?: { jobId?: string; status?: string; transaction?: string | null };
  /** Present on rejection — the real reason (verify revert / settle failure). */
  error?: string;
}

/** A settlement job's current state (GET /jobs/:id on the facilitator). */
export interface JobState {
  jobId: string;
  /** "submitted" | "pending" | "confirmed" | "failed". */
  status: string;
  transaction?: string | null;
  error?: string | null;
  /** How it confirmed: "webhook" (1Shot signed push) or "poll" (fallback). */
  confirmedVia?: "webhook" | "poll" | null;
}

/**
 * Poll the facilitator for a settlement job's state. Settlement is async (1Shot
 * relays + confirms the tx out of band); this is the reliable, SSE-independent
 * way to learn the on-chain tx hash and terminal status. Returns null on a
 * transient fetch error so the caller can keep polling.
 */
export async function fetchJob(jobId: string): Promise<JobState | null> {
  try {
    const res = await fetch(`${config.facilitatorUrl}/jobs/${jobId}`);
    if (!res.ok) return null;
    const b = (await res.json()) as {
      status?: string; transaction?: string | null; error?: string | null;
      confirmedVia?: "webhook" | "poll" | null;
    };
    if (!b.status) return null;
    return {
      jobId, status: b.status, transaction: b.transaction ?? null,
      error: b.error ?? null, confirmedVia: b.confirmedVia ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Re-GET the resource with the X-PAYMENT header (base64 JSON per x402). The
 * endpoint verifies (simulation) then settles (relayer submits the redemption)
 * and, on success, returns the asset + settlement info.
 *
 * `opts.path` targets a catalog service; `opts.agent`/`opts.correlationId` are
 * forwarded as headers so the facilitator's live event feed is labeled with
 * who/what is paying.
 */
export async function payAndClaim(
  paymentPayload: unknown,
  opts: { path?: string; agent?: string; correlationId?: string; topic?: string } = {}
): Promise<ClaimResult> {
  const header = btoa(JSON.stringify(paymentPayload));
  const headers: Record<string, string> = { "X-PAYMENT": header };
  if (opts.agent) headers["X-AGENT"] = opts.agent;
  if (opts.correlationId) headers["X-CORRELATION-ID"] = opts.correlationId;
  // The topic → the agent produces its output about it (X-TOPIC). Usually the
  // user prompt; the Yield Scout passes a small JSON blob (goal + approved set),
  // so allow enough room that the encoded payload is never truncated mid-escape.
  if (opts.topic) headers["X-TOPIC"] = encodeURIComponent(opts.topic).slice(0, 4000);
  const res = await fetch(`${config.endpointUrl}${opts.path ?? RESOURCE_PATH}`, {
    headers,
  });
  const body = await res.json().catch(() => ({}) as Record<string, unknown>);

  if (res.status === 200) {
    return {
      ok: true,
      status: 200,
      data: (body as { data?: unknown }).data,
      settlement: (body as { settlement?: ClaimResult["settlement"] }).settlement,
    };
  }

  // 402 (verify failed) → body.error; 502 (settle failed) → body.error + detail.
  const b = body as { error?: string; detail?: string };
  const error =
    [b.error, b.detail].filter(Boolean).join(" · ") || `HTTP ${res.status}`;
  return { ok: false, status: res.status, error };
}

/** One agent's delivered output in an atomic commission. */
export interface CommissionResult {
  service: string;
  label?: string;
  role?: string;
  data?: unknown;
}

export interface CommissionResponse {
  ok: boolean;
  status: number;
  settlement?: { jobId?: string; status?: string; transaction?: string | null; confirmedVia?: "webhook" | "poll" | null };
  results?: CommissionResult[];
  error?: string;
}

/**
 * Commission a whole team in ONE redeemDelegations batch — all-or-nothing.
 *
 * Done in three short requests (so no single connection is held open ~15-30s
 * and a hosting proxy can't time it out): submit the batch → poll the
 * facilitator job to on-chain confirmation → deliver the outputs. An over-budget
 * batch comes back as an error (rejected with no USDC moved); the outputs are
 * only ever fetched once the payment has actually settled.
 */
export async function commissionAtomic(
  paymentPayload: unknown,
  opts: { services: string[]; topic?: string; agent?: string; correlationId?: string }
): Promise<CommissionResponse> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.agent) headers["X-AGENT"] = opts.agent;
  if (opts.correlationId) headers["X-CORRELATION-ID"] = opts.correlationId;
  const fail = (status: number, body: { error?: string; detail?: string }, settlement?: CommissionResponse["settlement"]): CommissionResponse => ({
    ok: false,
    status,
    settlement,
    error: [body.error, body.detail].filter(Boolean).join(" · ") || `HTTP ${status}`,
  });

  // 1) Submit the batch — returns the settlement job immediately.
  const sRes = await fetch(`${config.endpointUrl}/commission`, {
    method: "POST",
    headers,
    body: JSON.stringify({ paymentPayload }),
  });
  const sBody = (await sRes.json().catch(() => ({}))) as {
    error?: string; detail?: string; settlement?: CommissionResponse["settlement"];
  };
  if (sRes.status !== 200) return fail(sRes.status, sBody, sBody.settlement);
  const jobId = sBody.settlement?.jobId;
  if (!jobId) return fail(502, { error: "no settlement job returned" });

  // 2) Poll the facilitator job until the batch confirms on-chain (or fails).
  let tx = sBody.settlement?.transaction ?? null;
  let confirmed = sBody.settlement?.status === "confirmed";
  let confirmedVia: "webhook" | "poll" | null = null;
  const deadline = Date.now() + 150_000; // ~2.5 min, matches the relayer window
  while (!confirmed && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const job = await fetchJob(jobId);
    if (!job) continue;
    if (job.status === "failed") {
      return fail(502, { error: job.error ?? "the payment did not go through" }, { jobId, status: "failed", transaction: job.transaction });
    }
    if (job.status === "confirmed") {
      tx = job.transaction ?? tx;
      confirmedVia = job.confirmedVia ?? null;
      confirmed = true;
    }
  }
  if (!confirmed) return fail(504, { error: "the payment did not confirm in time" }, { jobId, status: "pending", transaction: tx });

  // 3) Deliver — fetch every agent's output now that the payment settled.
  const dRes = await fetch(`${config.endpointUrl}/commission/deliver`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jobId, services: opts.services, topic: opts.topic }),
  });
  const dBody = (await dRes.json().catch(() => ({}))) as {
    error?: string; detail?: string; settlement?: CommissionResponse["settlement"]; results?: CommissionResult[];
  };
  if (dRes.status !== 200) return fail(dRes.status, dBody, { jobId, status: "confirmed", transaction: tx, confirmedVia });
  return {
    ok: true,
    status: 200,
    settlement: { ...(dBody.settlement ?? {}), jobId, status: "confirmed", transaction: tx, confirmedVia },
    results: dBody.results,
  };
}

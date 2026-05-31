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
  kind: "image" | "text" | "data";
  priceUsdc: string;
  priceBaseUnits: string;
  /** Relative resource path, e.g. "/services/venice-image". */
  resource: string;
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
  opts: { path?: string; agent?: string; correlationId?: string } = {}
): Promise<ClaimResult> {
  const header = btoa(JSON.stringify(paymentPayload));
  const headers: Record<string, string> = { "X-PAYMENT": header };
  if (opts.agent) headers["X-AGENT"] = opts.agent;
  if (opts.correlationId) headers["X-CORRELATION-ID"] = opts.correlationId;
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

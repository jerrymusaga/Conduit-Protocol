import express, { type Request, type Response } from "express";
import { config } from "./config.js";
import { chainInfo } from "./chain.js";
import {
  fetchCapabilities,
  settle,
  verify,
  type ConduitCapabilities,
} from "./facilitatorClient.js";
import { buildPaymentRequired } from "./paymentRequired.js";
import { SERVICES, LEGACY_SERVICE, getService, type Service } from "./services.js";
import { veniceChat, veniceRpc, veniceEnabled } from "./venice.js";
import { hexToBigInt } from "viem";

const app = express();
app.use(express.json({ limit: "5mb" }));

// CORS — the Conduit dapp (a browser app on another origin) drives this
// endpoint directly. Allow the X-PAYMENT header and answer preflight.
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header(
    "Access-Control-Allow-Headers",
    "Content-Type, X-PAYMENT, X-AGENT, X-CORRELATION-ID"
  );
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Expose-Headers", "X-PAYMENT-RESPONSE");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Cache the facilitator's capabilities. Fetched lazily so the endpoint can
// start before the facilitator is up (dev convenience), refreshed if missing.
let capsCache: ConduitCapabilities | undefined;
async function getCaps(): Promise<ConduitCapabilities> {
  // Don't cache an incomplete capabilities response: on the oneshot-pl backend
  // the redeemer (1Shot targetAddress) is warmed asynchronously, so an early
  // fetch can return null. Refetch until it's populated.
  if (capsCache && capsCache.redeemer) return capsCache;
  capsCache = await fetchCapabilities();
  return capsCache;
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    chainId: config.chainId,
    network: chainInfo.caip2,
    facilitator: config.facilitatorUrl,
    payTo: config.payTo,
    price: `${config.priceUsdc} USDC`,
  });
});

// GET /services — the catalog the coordinator chooses from.
app.get("/services", (_req, res) => {
  res.json({
    services: SERVICES.map((s) => ({
      id: s.id,
      label: s.label,
      description: s.description,
      kind: s.kind,
      priceUsdc: s.priceUsdc,
      priceBaseUnits: s.priceBaseUnits.toString(),
      resource: `/services/${s.id}`,
    })),
  });
});

// --- Provider intelligence (Venice-powered, canned fallback) ----------------
// The seller generates what it sells via Venice AFTER the erc7710 payment
// settles. Every Venice call is best-effort; on any failure the canned value is
// returned so the demo stays reliable. `source` labels what produced the output
// so the report can attribute it ("via Venice · on-chain" vs "cached").

const CANNED = {
  data: {
    stakingTVL: "$160B", stakedETH: "34.2M", percentSupplyStaked: "28.4%",
    activeValidators: 1_068_000, apr: "3.1%",
  } as Record<string, unknown>,
  news:
    "ETH staking inflows rose ~12% this week on renewed ETF demand; net new " +
    "deposits outpaced exits, and the validator entry queue lengthened slightly.",
  analytics:
    "Staking remains concentrated among large liquid-staking protocols, though " +
    "Lido's share is gradually declining as solo + restaking options grow. " +
    "Outlook: stable issuance, modest restaking-driven growth, watch LST concentration.",
};

// Ethereum mainnet contracts the Data Agent reads via Venice's RPC proxy.
const ETH2_DEPOSIT = "0x00000000219ab540356cBB839Cbe05303d7705Fa"; // beacon deposit contract
const LIDO_STETH = "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84"; // stETH
const SELECTOR_TOTAL_SUPPLY = "0x18160ddd"; // totalSupply()

/** wei (bigint) → "34.21M ETH" style human string. */
function fmtEth(wei: bigint): string {
  const eth = Number(wei) / 1e18;
  if (eth >= 1e6) return `${(eth / 1e6).toFixed(2)}M ETH`;
  if (eth >= 1e3) return `${(eth / 1e3).toFixed(1)}K ETH`;
  return `${eth.toFixed(2)} ETH`;
}

/** Data Agent: real on-chain ETH-staking metrics via Venice crypto-rpc. */
async function stakingDataOutput(): Promise<Record<string, unknown>> {
  const net = "ethereum-mainnet";
  const [blockHex, depositBalHex, lidoSupplyHex] = await Promise.all([
    veniceRpc(net, "eth_blockNumber", []),
    veniceRpc(net, "eth_getBalance", [ETH2_DEPOSIT, "latest"]),
    veniceRpc(net, "eth_call", [{ to: LIDO_STETH, data: SELECTOR_TOTAL_SUPPLY }, "latest"]),
  ]);

  // If nothing came back live, serve the canned snapshot.
  if (!blockHex && !depositBalHex && !lidoSupplyHex) {
    return { type: "data", source: "cached", content: CANNED.data };
  }

  const content: Record<string, unknown> = { ...CANNED.data };
  if (depositBalHex) content.totalDepositedETH = fmtEth(hexToBigInt(depositBalHex as `0x${string}`));
  if (lidoSupplyHex) content.lidoStakedETH = fmtEth(hexToBigInt(lidoSupplyHex as `0x${string}`));
  if (blockHex) content.atBlock = Number(hexToBigInt(blockHex as `0x${string}`));
  return { type: "data", source: "venice:crypto-rpc · ethereum-mainnet", content };
}

/** News Agent: recent ETH-staking news via Venice chat + web search. */
async function stakingNewsOutput(): Promise<Record<string, unknown>> {
  const text = await veniceChat(
    "You are a crypto news analyst. Reply with 2-3 sentences of the most recent " +
      "Ethereum staking news. Be concrete and current. No preamble, no markdown.",
    "Summarize this week's notable Ethereum staking news (flows, queue, ETFs, LSTs).",
    { webSearch: "on", stripThinking: true, maxTokens: 300 }
  );
  return text
    ? { type: "text", source: "venice:chat · web-search", content: text }
    : { type: "text", source: "cached", content: CANNED.news };
}

/** Analytics Agent: ETH-staking market analysis via a Venice reasoning model. */
async function stakingAnalyticsOutput(): Promise<Record<string, unknown>> {
  const text = await veniceChat(
    "You are an Ethereum staking market analyst. Reply with a 3-4 sentence " +
      "analysis: liquid-staking concentration, restaking, and a short outlook. " +
      "No preamble, no markdown.",
    "Analyze the current Ethereum staking market structure and give an outlook.",
    { reasoningEffort: "low", stripThinking: true, maxTokens: 400 }
  );
  return text
    ? { type: "text", source: "venice:chat · reasoning", content: text }
    : { type: "text", source: "cached", content: CANNED.analytics };
}

/** Produce the success payload for a settled service. */
async function serviceResult(service: Service): Promise<Record<string, unknown>> {
  // Per-provider staking outputs the procurement agent aggregates into a report.
  switch (service.id) {
    case "staking-data":
      return stakingDataOutput();
    case "staking-news":
      return stakingNewsOutput();
    case "staking-analytics":
      return stakingAnalyticsOutput();
  }
  switch (service.kind) {
    case "image":
      return { type: "image", note: "image generation placeholder (Venice next)",
        prompt: service.label };
    case "text":
      return { type: "text", content: `Generated copy for: ${service.label}` };
    case "subscription":
      return { type: "subscription", content: {
        service: service.id,
        feed: "market-pulse",
        period: service.subscription?.periodSeconds,
        sample: { index: Math.random().toString(36).slice(2, 8), at: Date.now() },
      } };
    default:
      return { type: "data", content: { service: service.id, sample: true } };
  }
}

/**
 * The paid resource handler, shared by every catalog service and the legacy
 * /paid-data. Runs the x402 exchange: 402 → X-PAYMENT → verify → settle →
 * serve. Forwards a `meta` block to the facilitator so the live console feed is
 * labeled with the service + the requesting agent (X-AGENT header).
 */
async function handlePaidResource(
  service: Service,
  req: Request,
  res: Response
) {
  const resourceUrl = `${req.protocol}://${req.get("host")}${req.originalUrl}`;

  let caps: ConduitCapabilities;
  try {
    caps = await getCaps();
  } catch (err) {
    return res.status(503).json({
      error: "facilitator unreachable",
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  const paymentHeader = req.header("X-PAYMENT");
  if (!paymentHeader) {
    return res
      .status(402)
      .json(buildPaymentRequired(resourceUrl, caps, service, "X-PAYMENT header required"));
  }

  let paymentPayload: unknown;
  try {
    paymentPayload = JSON.parse(
      Buffer.from(paymentHeader, "base64").toString("utf8")
    );
  } catch {
    return res.status(400).json({ error: "X-PAYMENT is not valid base64 JSON" });
  }

  // Labels for the Conduit console event feed. The agent name comes from an
  // optional X-AGENT header the caller sets; correlationId ties the events of
  // this one payment together (we reuse the x402 intent hash if present).
  const meta = {
    service: service.id,
    agent: req.header("X-AGENT") ?? undefined,
    resource: resourceUrl,
    amount: service.priceBaseUnits.toString(),
    correlationId: req.header("X-CORRELATION-ID") ?? undefined,
  };

  const facilitatorRequest = {
    x402Version: 2,
    paymentPayload,
    paymentRequirements: buildPaymentRequired(resourceUrl, caps, service, "").accepts[0],
    meta,
  };

  const verification = await verify(facilitatorRequest);
  if (!verification.isValid) {
    return res.status(402).json(
      buildPaymentRequired(
        resourceUrl,
        caps,
        service,
        `payment verification failed: ${verification.invalidReason ?? "unknown"}`
      )
    );
  }

  const settlement = await settle(facilitatorRequest);
  if (!settlement.success) {
    return res.status(502).json({
      error: "settlement failed",
      detail: settlement.error ?? "unknown",
    });
  }

  const paymentResponse = Buffer.from(
    JSON.stringify({
      jobId: settlement.jobId,
      status: settlement.status,
      transaction: settlement.transaction ?? null,
    })
  ).toString("base64");

  res.setHeader("X-PAYMENT-RESPONSE", paymentResponse);
  res.json({
    service: service.id,
    data: await serviceResult(service),
    servedAt: new Date().toISOString(),
    settlement: {
      jobId: settlement.jobId,
      status: settlement.status,
      transaction: settlement.transaction ?? null,
    },
  });
}

// Per-service paid resource.
app.get("/services/:id", async (req: Request, res: Response) => {
  const service = getService(req.params.id ?? "");
  if (!service) return res.status(404).json({ error: "unknown service" });
  return handlePaidResource(service, req, res);
});

// Legacy single resource (kept for back-compat with the earlier demo flow).
app.get("/paid-data", (req: Request, res: Response) =>
  handlePaidResource(LEGACY_SERVICE, req, res)
);

app.listen(config.port, () => {
  console.log(`conduit-endpoint listening on :${config.port}`);
  console.log(`  network:     ${chainInfo.caip2}`);
  console.log(`  facilitator: ${config.facilitatorUrl}`);
  console.log(`  payTo:       ${config.payTo}`);
  console.log(`  services:    ${SERVICES.map((s) => s.id).join(", ")}`);
  console.log(`  catalog:     GET /services`);
  console.log(`  venice:      ${veniceEnabled() ? "ON (live intelligence)" : "off (canned fallback)"}`);
});

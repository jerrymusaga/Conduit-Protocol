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
import { veniceChat, veniceRpc, veniceImage, veniceSpeech, veniceEnabled } from "./venice.js";
import { hexToBigInt } from "viem";

const app = express();
app.use(express.json({ limit: "5mb" }));

// CORS — the Conduit dapp (a browser app on another origin) drives this
// endpoint directly. Allow the X-PAYMENT header and answer preflight.
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header(
    "Access-Control-Allow-Headers",
    "Content-Type, X-PAYMENT, X-AGENT, X-CORRELATION-ID, X-TOPIC"
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
      role: s.role,
      veniceEndpoint: s.veniceEndpoint,
      priceUsdc: s.priceUsdc,
      priceBaseUnits: s.priceBaseUnits.toString(),
      resource: `/services/${s.id}`,
      ...(s.subscription
        ? { subscription: { subscriptionId: s.subscription.subscriptionId, periodSeconds: s.subscription.periodSeconds } }
        : {}),
    })),
  });
});

// --- Agent outputs (Venice-powered, canned fallback) ------------------------
// Each agent produces its part ABOUT THE USER'S TOPIC via its Venice endpoint,
// AFTER the erc7710 payment settles. Every Venice call is best-effort; on any
// failure a canned value is returned so the demo stays reliable. `source` labels
// what produced the output ("venice:chat · web-search" vs "cached").

const DEFAULT_TOPIC = "an AI product launch";

// Ethereum mainnet contracts the Onchain Scout reads via Venice's RPC proxy.
const ETH2_DEPOSIT = "0x00000000219ab540356cBB839Cbe05303d7705Fa"; // beacon deposit contract
const LIDO_STETH = "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84"; // stETH
const SELECTOR_TOTAL_SUPPLY = "0x18160ddd"; // totalSupply()
const CANNED_ONCHAIN = {
  stakingTVL: "$160B", stakedETH: "34.2M", percentSupplyStaked: "28.4%",
  activeValidators: 1_068_000, apr: "3.1%",
} as Record<string, unknown>;

/** wei (bigint) → "34.21M ETH" style human string. */
function fmtEth(wei: bigint): string {
  const eth = Number(wei) / 1e18;
  if (eth >= 1e6) return `${(eth / 1e6).toFixed(2)}M ETH`;
  if (eth >= 1e3) return `${(eth / 1e3).toFixed(1)}K ETH`;
  return `${eth.toFixed(2)} ETH`;
}

type Output = Record<string, unknown>;

/** Researcher: web-search-grounded research on the topic (Venice chat+search). */
async function researchOutput(topic: string): Promise<Output> {
  const text = await veniceChat(
    "You are a research analyst. Reply with a tight 3-4 sentence research summary — " +
      "grounded, concrete, current. No preamble, no markdown.",
    `Research this topic for a brief: ${topic}`,
    { webSearch: "on", stripThinking: true, maxTokens: 350 }
  );
  return text
    ? { type: "text", source: "venice:chat · web-search", content: text }
    : { type: "text", source: "cached", content: `Research summary on ${topic}: an active, fast-moving space — note the key players, recent moves, and adoption signals.` };
}

/** Copywriter: a punchy positioning brief on the topic (Venice chat). */
async function copyOutput(topic: string): Promise<Output> {
  const text = await veniceChat(
    "You are a senior copywriter. Reply with a punchy 2-3 sentence positioning brief. " +
      "No preamble, no markdown.",
    `Write launch copy / a positioning brief for: ${topic}`,
    { stripThinking: true, maxTokens: 250 }
  );
  return text
    ? { type: "text", source: "venice:chat", content: text }
    : { type: "text", source: "cached", content: `${topic} — built for the moment. Clear value, sharp positioning, ready to ship.` };
}

/** Analyst: market/landscape analysis + outlook (Venice reasoning model). */
async function analysisOutput(topic: string): Promise<Output> {
  const text = await veniceChat(
    "You are a market analyst. Reply with a 3-4 sentence analysis + a one-line " +
      "outlook. No preamble, no markdown.",
    `Analyze the market/landscape for: ${topic}`,
    { reasoningEffort: "low", stripThinking: true, maxTokens: 400 }
  );
  return text
    ? { type: "text", source: "venice:chat · reasoning", content: text }
    : { type: "text", source: "cached", content: `Analysis of ${topic}: balanced fundamentals, real competition, a clear adoption path. Outlook: cautiously positive.` };
}

/** Onchain Scout: real on-chain crypto metrics via Venice crypto-rpc. */
async function onchainOutput(): Promise<Output> {
  const net = "ethereum-mainnet";
  const [blockHex, depositBalHex, lidoSupplyHex] = await Promise.all([
    veniceRpc(net, "eth_blockNumber", []),
    veniceRpc(net, "eth_getBalance", [ETH2_DEPOSIT, "latest"]),
    veniceRpc(net, "eth_call", [{ to: LIDO_STETH, data: SELECTOR_TOTAL_SUPPLY }, "latest"]),
  ]);
  if (!blockHex && !depositBalHex && !lidoSupplyHex) {
    return { type: "data", source: "cached", content: CANNED_ONCHAIN };
  }
  const content: Record<string, unknown> = { ...CANNED_ONCHAIN };
  if (depositBalHex) content.totalDepositedETH = fmtEth(hexToBigInt(depositBalHex as `0x${string}`));
  if (lidoSupplyHex) content.lidoStakedETH = fmtEth(hexToBigInt(lidoSupplyHex as `0x${string}`));
  if (blockHex) content.atBlock = Number(hexToBigInt(blockHex as `0x${string}`));
  return { type: "data", source: "venice:crypto-rpc · ethereum-mainnet", content };
}

/** Illustrator: a cover image for the topic (Venice image) → data URL. */
async function imageOutput(topic: string): Promise<Output> {
  const url = await veniceImage(
    `Editorial cover illustration for "${topic}". Clean, modern, high-end, abstract. ` +
      "No text, no words, no letters."
  );
  return url
    ? { type: "image", source: "venice:image", content: url }
    : { type: "image", source: "cached", content: null, note: "image unavailable (no Venice key/credits)" };
}

/** Narrator: a spoken summary of the deliverable (Venice TTS) → playable audio. */
async function voiceOutput(topic: string): Promise<Output> {
  const script =
    (await veniceChat(
      "Write ONE spoken sentence (max 30 words) summarizing a deliverable for a " +
        "voiceover. No preamble, no markdown.",
      `One spoken sentence summarizing a brief about: ${topic}`,
      { stripThinking: true, maxTokens: 80 }
    )) ?? `Here is your brief on ${topic}.`;
  const audio = await veniceSpeech(script);
  return audio
    ? { type: "audio", source: "venice:tts", content: audio, transcript: script }
    : { type: "audio", source: "cached", content: null, transcript: script, note: "voiceover unavailable (no Venice key/credits)" };
}

/** Subscription feed: a recurring sample (the period mechanic is the demo beat). */
function feedOutput(service: Service): Output {
  return { type: "subscription", source: "venice:chat", content: {
    service: service.id,
    period: service.subscription?.periodSeconds,
    sample: { index: Math.random().toString(36).slice(2, 8), at: Date.now() },
  } };
}

/** Produce the success payload for a settled service — by ROLE, about `topic`. */
async function serviceResult(service: Service, topic: string): Promise<Output> {
  switch (service.role) {
    case "research": return researchOutput(topic);
    case "copy": return copyOutput(topic);
    case "analysis": return analysisOutput(topic);
    case "onchain": return onchainOutput();
    case "image": return imageOutput(topic);
    case "voice": return voiceOutput(topic);
    case "feed": return feedOutput(service);
    default: return { type: "text", source: "cached", content: `Generated output for: ${service.label}` };
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

  // The agent produces its output ABOUT the user's topic (X-TOPIC header,
  // URL-encoded by the dapp for header-safety).
  let topic = DEFAULT_TOPIC;
  const rawTopic = req.header("X-TOPIC");
  if (rawTopic) {
    try {
      topic = decodeURIComponent(rawTopic).slice(0, 300).trim() || DEFAULT_TOPIC;
    } catch {
      /* malformed encoding — keep default */
    }
  }

  res.setHeader("X-PAYMENT-RESPONSE", paymentResponse);
  res.json({
    service: service.id,
    data: await serviceResult(service, topic),
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

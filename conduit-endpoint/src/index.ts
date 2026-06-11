import express, { type Request, type Response } from "express";
import { config } from "./config.js";
import { chainInfo } from "./chain.js";
import {
  fetchCapabilities,
  getJob,
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
    "You are a sharp research analyst. Using current web results, write 3-4 tight sentences " +
      "of research on the topic: lead with the single most important concrete fact, name " +
      "specific players, products or numbers where the sources support them, and close with " +
      "the key signal or trend. Confident and concrete — no preamble, no markdown, no hedging.",
    `Research this topic for a brief: ${topic}`,
    { webSearch: "on", stripThinking: true, maxTokens: 500 }
  );
  return text
    ? { type: "text", source: "venice:chat · web-search", content: text }
    : { type: "text", source: "venice unavailable", content: "Research couldn't be generated right now — please try again." };
}

/** Copywriter: a punchy positioning brief on the topic (Venice chat). */
async function copyOutput(topic: string): Promise<Output> {
  const text = await veniceChat(
    "You are a senior brand copywriter. Write a sharp positioning brief in 2-3 sentences: a " +
      "crisp value proposition plus the angle that makes it land. Confident, specific, fresh — " +
      "no clichés, no preamble, no markdown.",
    `Write launch copy / a positioning brief for: ${topic}`,
    { stripThinking: true, maxTokens: 300 }
  );
  return text
    ? { type: "text", source: "venice:chat", content: text }
    : { type: "text", source: "venice unavailable", content: "Copy couldn't be generated right now — please try again." };
}

/** Analyst: market/landscape analysis + outlook (Venice reasoning model). */
async function analysisOutput(topic: string): Promise<Output> {
  const text = await veniceChat(
    "You are a market analyst. In 3-4 sentences cover the key dynamics — demand, competition, " +
      "momentum — then add a one-line forward outlook. Specific and balanced, no fluff. " +
      "No preamble, no markdown.",
    `Analyze the market/landscape for: ${topic}`,
    { stripThinking: true, maxTokens: 500 }
  );
  return text
    ? { type: "text", source: "venice:chat", content: text }
    : { type: "text", source: "venice unavailable", content: "Analysis couldn't be generated right now — please try again." };
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
    return { type: "data", source: "venice unavailable", content: { note: "On-chain data couldn't be read right now — please try again." } };
  }
  // ONLY real RPC-derived values — no canned constants padding the result.
  const content: Record<string, unknown> = {};
  if (depositBalHex) content.totalDepositedETH = fmtEth(hexToBigInt(depositBalHex as `0x${string}`));
  if (lidoSupplyHex) content.lidoStakedETH = fmtEth(hexToBigInt(lidoSupplyHex as `0x${string}`));
  if (blockHex) content.atBlock = Number(hexToBigInt(blockHex as `0x${string}`));
  return { type: "data", source: "venice:crypto-rpc · ethereum-mainnet", content };
}

/** Illustrator: a cover image for the topic (Venice image) → data URL. */
async function imageOutput(topic: string): Promise<Output> {
  const url = await veniceImage(
    `A striking, premium editorial illustration that captures the theme of "${topic}". ` +
      "Modern, abstract and conceptual; sophisticated composition; high-end magazine quality; " +
      "tasteful color on a clean, uncluttered background. No text, no words, no letters, no numbers."
  );
  return url
    ? { type: "image", source: "venice:image", content: url }
    : { type: "image", source: "venice unavailable", content: null, note: "Image couldn't be generated right now — please try again." };
}

/**
 * Narrator: a spoken summary of the deliverable (Venice TTS) → playable audio.
 * `context` is a digest of what the OTHER agents actually produced — so the
 * voiceover narrates the real findings, not just the topic. The Narrator runs
 * LAST (see /commission/deliver) precisely so it has this.
 */
async function voiceOutput(topic: string, context?: string): Promise<Output> {
  const user = context
    ? `The team just produced this deliverable about "${topic}":\n\n${context}\n\n` +
      "Write ONE natural spoken sentence (max 30 words) that tells the listener the single " +
      "most important takeaway from it. No preamble, no markdown, no quotes."
    : `One spoken opening line summarizing a brief about: ${topic}`;
  const script = await veniceChat(
    "You are a voiceover narrator. Speak ONE natural, confident sentence that gives the listener " +
      "the key takeaway of the deliverable — specific and concrete, no jargon, no preamble, no quotes.",
    user,
    { stripThinking: true, maxTokens: 140 }
  );
  // No canned script: if Venice can't write one, don't synthesize a fake voiceover.
  if (!script) {
    return { type: "audio", source: "venice unavailable", content: null, note: "Voiceover couldn't be generated right now — please try again." };
  }
  const audio = await veniceSpeech(script);
  return audio
    ? { type: "audio", source: "venice:tts", content: audio, transcript: script }
    : { type: "audio", source: "venice unavailable", content: null, transcript: script, note: "Voiceover couldn't be generated right now — please try again." };
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

/**
 * POST /commission — the ATOMIC COMMISSION beat (submit half). Submit ONE
 * redeemDelegations batch (the buyer's `paymentPayload` carries N intent-bound
 * work legs + one shared fee leg) and return the settlement job IMMEDIATELY.
 * The dapp polls the job to on-chain confirmation, then calls
 * POST /commission/deliver for the outputs. Splitting submit from deliver keeps
 * every request short, so a hosting proxy never has to hold a connection open
 * for the ~15-30s the batch takes to mine.
 *
 * Body: { paymentPayload }
 */
app.post("/commission", async (req: Request, res: Response) => {
  const body = req.body as { paymentPayload?: unknown };
  if (!body.paymentPayload || typeof body.paymentPayload !== "object") {
    return res.status(400).json({ error: "paymentPayload (the batch) is required" });
  }

  // Submit the whole batch ONCE. paymentRequirements is optional for erc7710
  // (verification is simulation-based); the batch is self-contained.
  const settlement = await settle({
    x402Version: 2,
    paymentPayload: body.paymentPayload,
    meta: {
      service: "commission",
      agent: req.header("X-AGENT") ?? "coordinator",
      correlationId: req.header("X-CORRELATION-ID") ?? undefined,
    },
  });

  if (!settlement.success) {
    // Rejected at submission (e.g. over budget) → the batch never broadcast.
    return res.status(502).json({
      error: "commission settlement failed",
      detail: settlement.error ?? "unknown",
      settlement,
    });
  }

  // Return the job at once — delivery happens at /commission/deliver after the
  // dapp confirms the batch settled on-chain.
  res.json({
    commission: true,
    settlement: {
      jobId: settlement.jobId,
      status: settlement.status,
      transaction: settlement.transaction ?? null,
    },
  });
});

/**
 * POST /commission/deliver — produce every agent's output, but ONLY for a batch
 * that actually settled on-chain. All-or-nothing is preserved: we verify the
 * settlement job is `confirmed` before generating anything, so a payment that
 * didn't stick yields no output (and no Venice spend). Returns 202 while still
 * pending so the dapp keeps polling; 502 if it failed.
 *
 * Body: { jobId, services: string[] (catalog ids, in plan order), topic }
 */
app.post("/commission/deliver", async (req: Request, res: Response) => {
  const body = req.body as { jobId?: unknown; services?: unknown; topic?: unknown };
  if (typeof body.jobId !== "string" || !body.jobId) {
    return res.status(400).json({ error: "jobId is required" });
  }
  const ids = Array.isArray(body.services) ? body.services : [];
  if (ids.length === 0 || !ids.every((s) => typeof s === "string")) {
    return res.status(400).json({ error: "services must be a non-empty string[]" });
  }
  const services = (ids as string[]).map((id) => getService(id));
  const missing = (ids as string[]).filter((_id, i) => !services[i]);
  if (missing.length > 0) {
    return res.status(404).json({ error: `unknown service(s): ${missing.join(", ")}` });
  }
  const topic =
    typeof body.topic === "string" && body.topic.trim()
      ? body.topic.slice(0, 300).trim()
      : DEFAULT_TOPIC;

  // Gate delivery on real on-chain settlement — never hand over work (or spend
  // Venice credits) for an unsettled or failed payment.
  const job = await getJob(body.jobId);
  if (!job) return res.status(404).json({ error: "unknown settlement job" });
  if (job.status === "failed") {
    return res.status(502).json({
      error: "commission settlement failed",
      detail: job.error ?? "the payment did not go through",
    });
  }
  if (job.status !== "confirmed") {
    // Still mining — tell the dapp to keep polling.
    return res.status(202).json({ pending: true, status: job.status });
  }

  // Settled on-chain → every agent produces its Venice output about the topic.
  // The Narrator runs LAST with the others' outputs as context, so it voices the
  // ACTUAL deliverable (what the team produced), not just the topic.
  let results;
  try {
    const svc = services as Service[];
    const others = svc.filter((s) => s.role !== "voice");
    const narrators = svc.filter((s) => s.role === "voice");

    const otherResults = await Promise.all(
      others.map(async (s) => ({ service: s.id, label: s.label, role: s.role, data: await serviceResult(s, topic) }))
    );

    // Digest the team's text/data outputs for the narrator (cap the length).
    const digest = otherResults
      .map((r) => {
        const c = (r.data as { content?: unknown } | undefined)?.content;
        if (typeof c === "string") return `${r.label}: ${c}`;
        if (c && typeof c === "object") return `${r.label}: ${JSON.stringify(c)}`;
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .slice(0, 1600);

    const narratorResults = await Promise.all(
      narrators.map(async (s) => ({ service: s.id, label: s.label, role: s.role, data: await voiceOutput(topic, digest || undefined) }))
    );

    // Reassemble in the originally-requested order.
    const byId = new Map([...otherResults, ...narratorResults].map((r) => [r.service, r]));
    results = svc.map((s) => byId.get(s.id)!);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[commission/deliver] output generation failed:", detail);
    return res.status(502).json({ error: "couldn't generate outputs", detail });
  }

  res.json({
    commission: true,
    count: results.length,
    settlement: { jobId: body.jobId, status: "confirmed", transaction: job.transaction ?? null },
    results,
    servedAt: new Date().toISOString(),
  });
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

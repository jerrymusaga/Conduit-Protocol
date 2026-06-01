import express from "express";
import { config } from "./config.js";
import { chainConfig } from "./chain.js";
import { selectRelayBackend } from "./relayers/index.js";
import { supportedRouter } from "./routes/supported.js";
import { verifyRouter } from "./routes/verify.js";
import { settleRouter } from "./routes/settle.js";
import { relayerWebhookRouter } from "./routes/relayerWebhook.js";
import { setTerminalHook } from "./jobs.js";
import { fireWebhook } from "./webhook.js";

const backend = selectRelayBackend();

// Forward every settled job to the integrator's WEBHOOK_URL (one place, all
// relay paths). This is the dev-facing webhook: build on Conduit, register a
// URL, get push settlement events — no relayer/chain/crypto on their side.
setTerminalHook((job) => void fireWebhook(job));

const app = express();
app.use(express.json({ limit: "5mb" }));

// CORS — the Conduit console (a browser app on another origin) subscribes to
// the SSE event stream and may call the facilitator directly.
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Health check
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    chainId: config.chainId,
    network: chainConfig.caip2,
    relayBackend: backend.name,
    receiptEnforcer: config.receiptEnforcer,
  });
});

app.use(supportedRouter(backend));
app.use(verifyRouter(backend));
app.use(settleRouter(backend));
app.use(relayerWebhookRouter);

app.listen(config.port, () => {
  console.log(`conduit-facilitator listening on :${config.port}`);
  console.log(`  network:          ${chainConfig.caip2}`);
  console.log(`  relay backend:    ${backend.name}`);
  console.log(`  receipt enforcer: ${config.receiptEnforcer}`);
  console.log(`  delegation mgr:   ${chainConfig.delegationManager}`);
  if (backend.name === "oneshot-pl") {
    console.log(
      "  relaying through the 1Shot Permissionless Relayer (gas paid in stablecoin)"
    );
  }
});

/**
 * Venice API client (server-side). The SELLER generates what it sells via
 * Venice's "permissionless intelligence" — text, on-chain RPC reads, web search.
 *
 * Honest architecture (see conduit-venice-track-plan memory): payments stay on
 * Conduit's erc7710 rails; Venice is the INTELLIGENCE behind the paid provider
 * agents, consumed here with a Bearer key AFTER the erc7710 payment settles.
 * Venice's own x402 is EIP-3009 (not erc7710), so we do NOT route it through
 * Conduit — we call it Bearer-side. The key NEVER leaves the server.
 *
 * Every helper is best-effort: if VENICE_API_KEY is unset or a call fails, it
 * returns null and the caller falls back to its canned value, so the demo stays
 * reliable even when Venice is unreachable.
 */
import { config } from "./config.js";

const VENICE_BASE = "https://api.venice.ai/api/v1";

/** Default text model — a capable reasoning model. Overridable per call. */
const DEFAULT_CHAT_MODEL = "zai-org-glm-5-1";

export function veniceEnabled(): boolean {
  return !!config.veniceApiKey;
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    Authorization: `Bearer ${config.veniceApiKey}`,
    ...extra,
  };
}

/** Wrap a Venice call so any failure (no key, network, non-2xx) yields null. */
async function safe<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  if (!veniceEnabled()) return null;
  try {
    return await fn();
  } catch (err) {
    console.warn(`[venice] ${label} failed, falling back:`, err instanceof Error ? err.message : err);
    return null;
  }
}

export interface ChatOptions {
  model?: string;
  /** Venice server-side web search ("on" | "auto"). */
  webSearch?: "on" | "auto";
  /** Reasoning effort for thinking models. */
  reasoningEffort?: "low" | "medium" | "high";
  /** Strip <think> tags from the visible answer. */
  stripThinking?: boolean;
  maxTokens?: number;
}

/**
 * POST /chat/completions — the agent brain. OpenAI-compatible plus Venice's
 * `venice_parameters` (web search, thinking control). Returns the assistant text
 * or null on any failure.
 */
export async function veniceChat(
  system: string,
  user: string,
  opts: ChatOptions = {}
): Promise<string | null> {
  return safe("chat", async () => {
    const venice_parameters: Record<string, unknown> = {};
    if (opts.webSearch) venice_parameters.enable_web_search = opts.webSearch;
    if (opts.stripThinking) venice_parameters.strip_thinking_response = true;

    const body: Record<string, unknown> = {
      model: opts.model ?? DEFAULT_CHAT_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_completion_tokens: opts.maxTokens ?? 600,
    };
    if (opts.reasoningEffort) body.reasoning = { effort: opts.reasoningEffort };
    if (Object.keys(venice_parameters).length) body.venice_parameters = venice_parameters;

    const res = await fetch(`${VENICE_BASE}/chat/completions`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`chat ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = json.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error("empty completion");
    return text;
  });
}

/**
 * POST /crypto/rpc/{network} — Venice's pay-per-call JSON-RPC proxy. Lets the
 * Data Agent read REAL on-chain state (the "Venice + on-chain data" lever).
 * Returns the JSON-RPC `result` (hex string) or null.
 */
export async function veniceRpc(
  network: string,
  method: string,
  params: unknown[]
): Promise<string | null> {
  return safe(`rpc:${method}`, async () => {
    const res = await fetch(`${VENICE_BASE}/crypto/rpc/${network}`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
    });
    if (!res.ok) throw new Error(`rpc ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { result?: string; error?: { message?: string } };
    if (json.error) throw new Error(json.error.message ?? "rpc error");
    if (json.result == null) throw new Error("no result");
    return json.result;
  });
}

/** POST /image/generate → a data: URL (png), or null on any failure. */
export async function veniceImage(prompt: string): Promise<string | null> {
  return safe("image", async () => {
    const res = await fetch(`${VENICE_BASE}/image/generate`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        // flux-2-pro: premium editorial quality that reliably honors "no text"
        // (z-image-turbo rendered garbled letters and looked average).
        model: "flux-2-pro",
        prompt,
        width: 1024,
        height: 1024,
        format: "png",
        safe_mode: true,
        return_binary: false,
      }),
    });
    if (!res.ok) throw new Error(`image ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { images?: string[] };
    const b64 = json.images?.[0];
    if (!b64) throw new Error("no image");
    return `data:image/png;base64,${b64}`;
  });
}

/** POST /audio/speech → a data: URL (mp3) for a playable voiceover, or null. */
export async function veniceSpeech(text: string): Promise<string | null> {
  return safe("speech", async () => {
    const res = await fetch(`${VENICE_BASE}/audio/speech`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        // ElevenLabs Turbo v2.5: broadcast-grade natural narration (kokoro
        // sounded robotic). "Aria" is a warm, confident female voice.
        model: "tts-elevenlabs-turbo-v2-5",
        input: text,
        voice: "Aria",
        response_format: "mp3",
      }),
    });
    if (!res.ok) throw new Error(`speech ${res.status}: ${await res.text()}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) throw new Error("empty audio");
    return `data:audio/mp3;base64,${buf.toString("base64")}`;
  });
}

export interface SearchResult {
  title: string;
  url: string;
  content: string;
  date?: string;
}

/**
 * POST /augment/search — zero-retention web search. Returns structured results
 * the News/Data agents can ground their output in, or null.
 */
export async function veniceSearch(
  query: string,
  limit = 5
): Promise<SearchResult[] | null> {
  return safe("search", async () => {
    const res = await fetch(`${VENICE_BASE}/augment/search`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ query, limit, search_provider: "brave" }),
    });
    if (!res.ok) throw new Error(`search ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { results?: SearchResult[] };
    return json.results ?? [];
  });
}

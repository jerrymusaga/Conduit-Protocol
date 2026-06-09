/**
 * SERVER-ONLY Venice helpers. Used by the dapp's route handlers (app/api/*) for
 * the COORDINATOR-side intelligence: voice transcription of the prompt, final
 * report aggregation, and the report cover image.
 *
 * The Bearer key lives in `VENICE_API_KEY` (NOT NEXT_PUBLIC_*) and never reaches
 * the browser. Every helper is best-effort: no key or a failed call returns null
 * and the caller falls back to its deterministic path, so the demo stays
 * reliable. See conduit-venice-track-plan memory.
 *
 * Do NOT import this from a Client Component — it reads a secret. Only the
 * route handlers under app/api/* (server-side by nature) import this.
 */

const VENICE_BASE = "https://api.venice.ai/api/v1";
const CHAT_MODEL = "zai-org-glm-5-1";
const IMAGE_MODEL = "z-image-turbo";

export function veniceKey(): string | undefined {
  return process.env.VENICE_API_KEY;
}

export function veniceEnabled(): boolean {
  return !!veniceKey();
}

function bearer(extra?: Record<string, string>): Record<string, string> {
  return { Authorization: `Bearer ${veniceKey()}`, ...extra };
}

/** POST /chat/completions → assistant text, or null on any failure. */
export async function veniceChat(
  system: string,
  user: string,
  opts: { maxTokens?: number; reasoningEffort?: "low" | "medium" | "high"; model?: string } = {}
): Promise<string | null> {
  if (!veniceEnabled()) return null;
  try {
    const body: Record<string, unknown> = {
      model: opts.model ?? CHAT_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_completion_tokens: opts.maxTokens ?? 900,
      venice_parameters: { strip_thinking_response: true },
    };
    if (opts.reasoningEffort) body.reasoning = { effort: opts.reasoningEffort };
    const res = await fetch(`${VENICE_BASE}/chat/completions`, {
      method: "POST",
      headers: bearer({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`chat ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return json.choices?.[0]?.message?.content?.trim() || null;
  } catch (err) {
    console.warn("[venice-server] chat failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

/** POST /image/generate → a data: URL (png), or null on any failure. */
export async function veniceImage(prompt: string): Promise<string | null> {
  if (!veniceEnabled()) return null;
  try {
    const res = await fetch(`${VENICE_BASE}/image/generate`, {
      method: "POST",
      headers: bearer({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        model: IMAGE_MODEL,
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
    return b64 ? `data:image/png;base64,${b64}` : null;
  } catch (err) {
    console.warn("[venice-server] image failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

/** POST /audio/transcriptions (multipart) → transcript text, or null. */
export async function veniceTranscribe(audio: Blob, filename: string): Promise<string | null> {
  if (!veniceEnabled()) return null;
  try {
    const form = new FormData();
    form.append("file", audio, filename);
    // whisper-large-v3 robustly decodes browser webm/opus & mp4/aac and is
    // multilingual + more accurate than parakeet-0.6b (English-only, finicky on
    // browser containers) — the source of the "always wrong" transcripts.
    form.append("model", "openai/whisper-large-v3");
    form.append("response_format", "json");
    const res = await fetch(`${VENICE_BASE}/audio/transcriptions`, {
      method: "POST",
      headers: bearer(), // no Content-Type — fetch sets the multipart boundary
      body: form,
    });
    if (!res.ok) throw new Error(`transcribe ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { text?: string };
    return json.text?.trim() || null;
  } catch (err) {
    console.warn("[venice-server] transcribe failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

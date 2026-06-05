/**
 * POST /api/transcribe — voice → text via Venice STT.
 *
 * The browser records the user's spoken request (MediaRecorder → audio/webm) and
 * posts it here as multipart/form-data; we forward it to Venice
 * /audio/transcriptions with the server-side Bearer key and return { text } to
 * drop into the prompt box. Keeps the key off the client. Venice is the very
 * first step of the main flow — speaking the request.
 */
import { NextResponse } from "next/server";
import { veniceTranscribe, veniceEnabled } from "@/lib/venice-server";

export const runtime = "nodejs";

export async function POST(req: Request) {
  if (!veniceEnabled()) {
    return NextResponse.json({ error: "transcription unavailable (no VENICE_API_KEY)" }, { status: 503 });
  }
  let file: File | null = null;
  try {
    const form = await req.formData();
    const f = form.get("audio");
    if (f instanceof File) file = f;
  } catch {
    return NextResponse.json({ error: "expected multipart/form-data with an 'audio' file" }, { status: 400 });
  }
  if (!file) {
    return NextResponse.json({ error: "missing 'audio' file" }, { status: 400 });
  }
  const text = await veniceTranscribe(file, file.name || "recording.webm");
  if (text == null) {
    return NextResponse.json({ error: "transcription failed" }, { status: 502 });
  }
  return NextResponse.json({ text });
}

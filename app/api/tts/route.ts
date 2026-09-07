import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

// Rachel — a warm, natural female voice from the ElevenLabs public library.
const DEFAULT_VOICE = "21m00Tcm4TlvDq8ikWAM";
const DEFAULT_MODEL = "eleven_turbo_v2_5";

export async function POST(request: Request) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  // 501 tells the client to fall back to the browser's own speech synthesis.
  if (!apiKey) {
    return NextResponse.json({ error: "ELEVENLABS_API_KEY not set" }, { status: 501 });
  }

  let text: string;
  try {
    ({ text } = await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!text?.trim()) {
    return NextResponse.json({ error: "No text provided" }, { status: 400 });
  }

  const voiceId = process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE;
  const modelId = process.env.ELEVENLABS_MODEL_ID || DEFAULT_MODEL;

  const upstream = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        text: text.slice(0, 2500),
        model_id: modelId,
        voice_settings: { stability: 0.4, similarity_boost: 0.75, style: 0.3, use_speaker_boost: true },
      }),
    },
  );

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    return NextResponse.json(
      { error: `ElevenLabs error ${upstream.status}: ${detail.slice(0, 300)}` },
      { status: 502 },
    );
  }

  return new Response(upstream.body, {
    headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" },
  });
}

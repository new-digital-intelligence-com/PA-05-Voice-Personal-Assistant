import { NextResponse } from "next/server";
import { SimliError, createSession, faceStatus, isConfigured } from "@/lib/simli";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET() {
  const configured = isConfigured();
  return NextResponse.json({
    configured,
    hasKey: Boolean(process.env.SIMLI_API_KEY),
    hasFace: Boolean(process.env.SIMLI_FACE_ID),
    faceProcessing: configured ? (await faceStatus()) === "processing" : false,
  });
}

export async function POST() {
  try {
    return NextResponse.json(await createSession());
  } catch (e) {
    if (e instanceof SimliError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Could not start a Simli session" },
      { status: 500 },
    );
  }
}

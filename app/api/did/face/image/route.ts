import { NextResponse } from "next/server";
import { readUploadedFace } from "@/lib/did";

export const runtime = "nodejs";

/** Serves the portrait that was uploaded through the app, for on-screen preview. */
export async function GET(request: Request) {
  const stored = await readUploadedFace();
  if (!stored) {
    // Nothing uploaded — fall back to the portrait that ships with the app.
    return NextResponse.redirect(new URL("/face.png", request.url));
  }
  return new Response(new Uint8Array(stored.bytes), {
    headers: { "Content-Type": stored.mime, "Cache-Control": "no-store" },
  });
}

import { NextResponse } from "next/server";
import { DidError, getFaceUrl, getFacePreview, uploadFace } from "@/lib/did";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_BYTES = 10 * 1024 * 1024;

export async function GET() {
  return NextResponse.json({
    configured: Boolean(process.env.DID_API_KEY),
    hasFace: Boolean(await getFaceUrl()),
    preview: await getFacePreview(),
  });
}

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const file = form.get("image");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "No image uploaded" }, { status: 400 });
    }
    if (!file.type.startsWith("image/")) {
      return NextResponse.json({ error: "That file is not an image" }, { status: 400 });
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json({ error: "Image must be under 10 MB" }, { status: 413 });
    }

    await uploadFace(file);
    return NextResponse.json({ hasFace: true, preview: await getFacePreview() });
  } catch (e) {
    if (e instanceof DidError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Upload failed" },
      { status: 500 },
    );
  }
}

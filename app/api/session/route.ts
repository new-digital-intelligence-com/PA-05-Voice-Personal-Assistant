import { NextResponse } from "next/server";
import { readSession } from "@/lib/session";

export const runtime = "nodejs";

export async function GET() {
  const session = await readSession();
  return NextResponse.json({
    googleConnected: Boolean(session.google),
    email: session.google?.email ?? null,
    anthropicConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
  });
}

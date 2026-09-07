import { NextResponse } from "next/server";
import {
  DidError,
  closeStream,
  createStream,
  getFaceUrl,
  sendAnswer,
  sendCandidate,
  speak,
} from "@/lib/did";

export const runtime = "nodejs";
export const maxDuration = 60;

type Body = {
  action: "status" | "create" | "sdp" | "ice" | "talk" | "close";
  id?: string;
  sessionId?: string;
  answer?: RTCSessionDescriptionInit;
  candidate?: Record<string, unknown>;
  text?: string;
};

export async function POST(request: Request) {
  let body: Body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    switch (body.action) {
      case "status":
        return NextResponse.json({
          configured: Boolean(process.env.DID_API_KEY),
          face: await getFaceUrl(),
        });

      case "create": {
        const face = await getFaceUrl();
        if (!face) {
          return NextResponse.json(
            { error: "No face uploaded yet. Add a portrait photo first." },
            { status: 428 },
          );
        }
        const session = await createStream(face);
        return NextResponse.json({
          id: session.id,
          sessionId: session.session_id,
          offer: session.offer,
          iceServers: session.ice_servers,
        });
      }

      case "sdp":
        if (!body.id || !body.sessionId || !body.answer) {
          return NextResponse.json({ error: "Missing id, sessionId or answer" }, { status: 400 });
        }
        await sendAnswer(body.id, body.sessionId, body.answer);
        return NextResponse.json({ ok: true });

      case "ice":
        if (!body.id || !body.sessionId) {
          return NextResponse.json({ error: "Missing id or sessionId" }, { status: 400 });
        }
        await sendCandidate(body.id, body.sessionId, body.candidate ?? {});
        return NextResponse.json({ ok: true });

      case "talk":
        if (!body.id || !body.sessionId || !body.text?.trim()) {
          return NextResponse.json({ error: "Missing id, sessionId or text" }, { status: 400 });
        }
        await speak(body.id, body.sessionId, body.text);
        return NextResponse.json({ ok: true });

      case "close":
        if (!body.id || !body.sessionId) {
          return NextResponse.json({ error: "Missing id or sessionId" }, { status: 400 });
        }
        await closeStream(body.id, body.sessionId).catch(() => undefined);
        return NextResponse.json({ ok: true });

      default:
        return NextResponse.json({ error: `Unknown action: ${body.action}` }, { status: 400 });
    }
  } catch (e) {
    if (e instanceof DidError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 },
    );
  }
}

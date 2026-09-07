import fs from "node:fs/promises";
import path from "node:path";

/**
 * D-ID Talks Streams — renders a photoreal face speaking, delivered over WebRTC.
 * Everything here runs server-side so the API key never reaches the browser.
 */

const BASE = "https://api.d-id.com";
const FACE_FILE = path.join(process.cwd(), "data", "did-face.json");
/** Shipped portrait, uploaded to D-ID the first time she is needed. */
const DEFAULT_FACE = path.join(process.cwd(), "public", "face.png");

export class DidError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * D-ID hands out keys as `username:key`. The header wants that base64-encoded, but
 * some dashboards already show the encoded form — accept either.
 */
function authHeader() {
  const key = process.env.DID_API_KEY;
  if (!key) throw new DidError("DID_API_KEY is not set. Add it to .env.local and restart.", 501);
  const encoded = key.includes(":") ? Buffer.from(key).toString("base64") : key;
  return `Basic ${encoded}`;
}

async function didFetch<T>(endpoint: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${endpoint}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: authHeader(),
      Accept: "application/json",
    },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const detail = body?.description ?? body?.message ?? body?.kind ?? `HTTP ${res.status}`;
    throw new DidError(`D-ID: ${detail}`, res.status);
  }
  return body as T;
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/* ------------------------------------------------------------------ face */

/**
 * The portrait D-ID animates. Resolution order: an explicit URL, then whatever was
 * uploaded through the app, then the portrait bundled at public/face.png. The result
 * is cached on disk so each photo is uploaded exactly once.
 */
export async function getFaceUrl(): Promise<string | null> {
  if (process.env.DID_SOURCE_URL) return process.env.DID_SOURCE_URL;

  try {
    const saved = JSON.parse(await fs.readFile(FACE_FILE, "utf8")) as { url?: string };
    if (saved.url) return saved.url;
  } catch {
    /* nothing uploaded yet */
  }

  if (!process.env.DID_API_KEY) return null;
  try {
    const bytes = await fs.readFile(DEFAULT_FACE);
    return await uploadFace(new File([bytes], "face.png", { type: "image/png" }));
  } catch {
    return null;
  }
}

export async function uploadFace(file: File): Promise<string> {
  const form = new FormData();
  form.append("image", file, file.name || "face.jpg");
  const result = await didFetch<{ url: string }>("/images", { method: "POST", body: form });

  await fs.mkdir(path.dirname(FACE_FILE), { recursive: true });
  await fs.writeFile(FACE_FILE, JSON.stringify({ url: result.url, at: new Date().toISOString() }));
  return result.url;
}

/* ---------------------------------------------------------------- stream */

export type StreamSession = {
  id: string;
  session_id: string;
  offer: RTCSessionDescriptionInit;
  ice_servers: RTCIceServer[];
};

export async function createStream(sourceUrl: string): Promise<StreamSession> {
  return didFetch<StreamSession>("/talks/streams", json({ source_url: sourceUrl }));
}

export async function sendAnswer(id: string, sessionId: string, answer: RTCSessionDescriptionInit) {
  return didFetch(`/talks/streams/${id}/sdp`, json({ answer, session_id: sessionId }));
}

export async function sendCandidate(id: string, sessionId: string, candidate: Record<string, unknown>) {
  // An empty candidate signals end-of-candidates; D-ID wants it sent as such.
  const payload = candidate.candidate
    ? { ...candidate, session_id: sessionId }
    : { candidate: null, session_id: sessionId };
  return didFetch(`/talks/streams/${id}/ice`, json(payload));
}

export async function speak(id: string, sessionId: string, text: string) {
  const provider =
    process.env.DID_VOICE_PROVIDER === "elevenlabs"
      ? { type: "elevenlabs", voice_id: process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM" }
      : { type: "microsoft", voice_id: process.env.DID_VOICE_ID || "en-US-JennyNeural" };

  return didFetch(
    `/talks/streams/${id}`,
    json({
      script: { type: "text", input: text.slice(0, 1000), provider, ssml: false },
      config: { stitch: true },
      session_id: sessionId,
    }),
  );
}

export async function closeStream(id: string, sessionId: string) {
  return didFetch(`/talks/streams/${id}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionId }),
  });
}

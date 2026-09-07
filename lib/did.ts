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
/** A copy of whatever portrait was uploaded, kept so the browser can display it. */
const UPLOAD_FILE = path.join(process.cwd(), "data", "face-source");

type FaceRecord = { url: string; mime?: string; at?: string; defaultFingerprint?: string };

async function readRecord(): Promise<FaceRecord | null> {
  try {
    return JSON.parse(await fs.readFile(FACE_FILE, "utf8")) as FaceRecord;
  } catch {
    return null;
  }
}

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

  const saved = await readRecord();
  if (!process.env.DID_API_KEY) return saved?.url ?? null;

  let fingerprint: string | null = null;
  let bytes: Buffer | null = null;
  try {
    bytes = await fs.readFile(DEFAULT_FACE);
    const stat = await fs.stat(DEFAULT_FACE);
    fingerprint = `${stat.size}`;
  } catch {
    /* no bundled portrait */
  }

  // A photo uploaded through the app always wins. Otherwise re-upload the bundled
  // portrait whenever the file itself has changed, so swapping public/face.png in the
  // repo is enough to change her face — no cache to clear by hand.
  if (saved?.url && (saved.mime || saved.defaultFingerprint === fingerprint)) {
    return saved.url;
  }

  if (!bytes) return saved?.url ?? null;
  try {
    // The default portrait is already served from /face.png, so no copy is needed.
    const blob = new File([new Uint8Array(bytes)], "face.png", { type: "image/png" });
    return await uploadFace(blob, false, fingerprint);
  } catch {
    return saved?.url ?? null;
  }
}

export async function uploadFace(
  file: File,
  keepCopy = true,
  defaultFingerprint: string | null = null,
): Promise<string> {
  const form = new FormData();
  form.append("image", file, file.name || "face.jpg");
  // D-ID answers with an s3:// URI. Their API accepts it as a source, but a browser
  // cannot render it — hence the local copy below for the on-screen preview.
  const result = await didFetch<{ url: string }>("/images", { method: "POST", body: form });

  await fs.mkdir(path.dirname(FACE_FILE), { recursive: true });
  if (keepCopy) {
    await fs.writeFile(UPLOAD_FILE, Buffer.from(await file.arrayBuffer()));
  }
  await fs.writeFile(
    FACE_FILE,
    JSON.stringify({
      url: result.url,
      mime: keepCopy ? file.type || "image/png" : undefined,
      defaultFingerprint: defaultFingerprint ?? undefined,
      at: new Date().toISOString(),
    }),
  );
  return result.url;
}

/** URL the browser should show as her still portrait. */
export async function getFacePreview(): Promise<string> {
  const saved = await readRecord();
  return saved?.mime ? "/api/did/face/image" : "/face.png";
}

/** The stored upload, for the preview route. */
export async function readUploadedFace(): Promise<{ bytes: Buffer; mime: string } | null> {
  const saved = await readRecord();
  if (!saved?.mime) return null;
  try {
    return { bytes: await fs.readFile(UPLOAD_FILE), mime: saved.mime };
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------- stream */

export type StreamSession = {
  id: string;
  session_id: string;
  offer: RTCSessionDescriptionInit;
  ice_servers: RTCIceServer[];
};

export async function createStream(sourceUrl: string): Promise<StreamSession> {
  // Streams default to a small, soft render — noticeably blurrier than the still
  // portrait beside it — so ask for a taller output and a warmed first frame.
  // Several of these settings are plan-gated ("user has no permission for ..."), and a
  // rejected extra must never cost her the ability to speak: try the richest payload
  // first, then progressively plainer ones.
  const resolution = Number(process.env.DID_OUTPUT_RESOLUTION ?? 1080);
  const timeout = process.env.DID_SESSION_TIMEOUT ? Number(process.env.DID_SESSION_TIMEOUT) : null;

  const attempts: Record<string, unknown>[] = [];
  if (timeout) {
    attempts.push({ output_resolution: resolution, stream_warmup: true, session_timeout: timeout });
  }
  attempts.push({ output_resolution: resolution, stream_warmup: true });
  attempts.push({ output_resolution: resolution });
  attempts.push({});

  let lastError: unknown;
  for (const extras of attempts) {
    try {
      return await didFetch<StreamSession>(
        "/talks/streams",
        json({ source_url: sourceUrl, ...extras }),
      );
    } catch (e) {
      lastError = e;
      const message = e instanceof Error ? e.message : "";
      // Only a rejected *option* is worth retrying without it. Anything else — a bad
      // key, no credits, the session limit — will fail the same way every time.
      if (!/no permission|not allowed|invalid|unsupported/i.test(message)) throw e;
    }
  }
  throw lastError;
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

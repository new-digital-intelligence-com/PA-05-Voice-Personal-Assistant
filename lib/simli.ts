/**
 * Simli — a photoreal face driven by raw audio, delivered over WebRTC.
 *
 * Unlike a render-per-sentence service, Simli takes a continuous PCM stream and
 * lip-syncs it live, so speech plays as one uninterrupted run. The API key stays
 * server-side; the browser only ever receives a short-lived session token.
 */

const BASE = "https://api.simli.ai";

export class SimliError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function apiKey() {
  const key = process.env.SIMLI_API_KEY;
  if (!key) throw new SimliError("SIMLI_API_KEY is not set. Add it to .env.local and restart.", 501);
  return key;
}

function faceId() {
  const face = process.env.SIMLI_FACE_ID;
  if (!face) {
    throw new SimliError(
      "SIMLI_FACE_ID is not set. Create an avatar from your photo at app.simli.com and paste its face ID into .env.local.",
      501,
    );
  }
  return face;
}

/**
 * A freshly created avatar spends a while in Simli's queue, and using it early fails
 * with INVALID_FACE_ID — so ask before connecting, and tell the user what is going on.
 */
export async function faceStatus(): Promise<"ready" | "processing" | "unknown"> {
  const key = process.env.SIMLI_API_KEY;
  const face = process.env.SIMLI_FACE_ID;
  if (!key || !face) return "unknown";
  try {
    const res = await fetch(`${BASE}/getRequestStatus`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-simli-api-key": key },
      body: JSON.stringify({ character_uid: face }),
    });
    if (!res.ok) return "unknown";
    const { status } = (await res.json()) as { status?: string };
    if (status === "processing" || status === "queued") return "processing";
    return status ? "ready" : "unknown";
  } catch {
    return "unknown";
  }
}

export type SimliSession = {
  sessionToken: string;
  iceServers: RTCIceServer[];
};

export async function createSession(): Promise<SimliSession> {
  const key = apiKey();

  const config = {
    faceId: faceId(),
    // We always feed her real speech, so Simli's own silence filler is unwanted.
    handleSilence: false,
    maxSessionLength: Number(process.env.SIMLI_MAX_SESSION ?? 1800),
    maxIdleTime: Number(process.env.SIMLI_MAX_IDLE ?? 600),
  };

  const tokenRes = await fetch(`${BASE}/compose/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-simli-api-key": key },
    body: JSON.stringify(config),
  });
  const tokenText = await tokenRes.text();
  if (!tokenRes.ok) {
    const friendly = /INVALID_FACE_ID/.test(tokenText)
      ? "Simli does not recognise that face ID yet — a newly created avatar is unusable until it finishes generating."
      : `Simli: ${tokenText.slice(0, 300)}`;
    throw new SimliError(friendly, tokenRes.status);
  }
  const { session_token } = JSON.parse(tokenText) as { session_token: string };
  if (!session_token || session_token === "FAIL TOKEN") {
    throw new SimliError(`Simli refused the session: ${tokenText.slice(0, 300)}`, 502);
  }

  // ICE is best-effort; the client falls back to a public STUN server without it.
  let iceServers: RTCIceServer[] = [{ urls: ["stun:stun.l.google.com:19302"] }];
  try {
    const iceRes = await fetch(`${BASE}/compose/ice`, {
      headers: { "Content-Type": "application/json", "x-simli-api-key": key },
    });
    if (iceRes.ok) {
      const servers = (await iceRes.json()) as RTCIceServer[];
      if (Array.isArray(servers) && servers.length) iceServers = servers;
    }
  } catch {
    /* keep the fallback */
  }

  return { sessionToken: session_token, iceServers };
}

export function isConfigured() {
  return Boolean(process.env.SIMLI_API_KEY && process.env.SIMLI_FACE_ID);
}

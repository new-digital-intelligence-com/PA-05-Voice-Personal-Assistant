import crypto from "node:crypto";
import { cookies } from "next/headers";

const COOKIE = "pa_session";
const ALG = "aes-256-gcm";

export type GoogleTokens = {
  access_token: string;
  refresh_token?: string;
  /** epoch ms */
  expires_at: number;
  scope?: string;
  email?: string;
};

export type Session = {
  google?: GoogleTokens;
};

function key(): Buffer {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not set (see .env.example)");
  return crypto.createHash("sha256").update(secret).digest();
}

function encrypt(value: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALG, key(), iv);
  const ct = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64url");
}

function decrypt(value: string): string | null {
  try {
    const raw = Buffer.from(value, "base64url");
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const decipher = crypto.createDecipheriv(ALG, key(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

export async function readSession(): Promise<Session> {
  const raw = (await cookies()).get(COOKIE)?.value;
  if (!raw) return {};
  const plain = decrypt(raw);
  if (!plain) return {};
  try {
    return JSON.parse(plain) as Session;
  } catch {
    return {};
  }
}

/** Serialised cookie value — set it on a NextResponse. */
export function sessionCookie(session: Session) {
  return {
    name: COOKIE,
    value: encrypt(JSON.stringify(session)),
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  };
}

export function clearedSessionCookie() {
  return { ...sessionCookie({}), value: "", maxAge: 0 };
}

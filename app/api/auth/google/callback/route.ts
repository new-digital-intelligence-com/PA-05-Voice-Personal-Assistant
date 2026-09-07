import { NextResponse } from "next/server";
import { exchangeCode } from "@/lib/google";
import { readSession, sessionCookie } from "@/lib/session";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const home = new URL("/", url.origin);

  const error = url.searchParams.get("error");
  if (error) {
    home.searchParams.set("google", `error:${error}`);
    return NextResponse.redirect(home);
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expectedState = request.headers
    .get("cookie")
    ?.split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith("pa_oauth_state="))
    ?.slice("pa_oauth_state=".length);

  if (!code || !state || state !== expectedState) {
    home.searchParams.set("google", "error:invalid_state");
    return NextResponse.redirect(home);
  }

  try {
    const tokens = await exchangeCode(code);
    const session = await readSession();
    // Google only returns a refresh token on the first consent — keep the old one.
    const merged = {
      ...session,
      google: { ...tokens, refresh_token: tokens.refresh_token ?? session.google?.refresh_token },
    };
    home.searchParams.set("google", "connected");
    const response = NextResponse.redirect(home);
    response.cookies.set(sessionCookie(merged));
    response.cookies.delete("pa_oauth_state");
    return response;
  } catch (e) {
    home.searchParams.set("google", `error:${e instanceof Error ? e.message : "unknown"}`);
    return NextResponse.redirect(home);
  }
}

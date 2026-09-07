import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { GoogleClient } from "@/lib/google";
import { readSession, sessionCookie } from "@/lib/session";
import { runTool, tools, type ToolContext } from "@/lib/tools";

export const runtime = "nodejs";
export const maxDuration = 60;

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5";
const MAX_ITERATIONS = 8;

type ChatTurn = { role: "user" | "assistant"; content: string };
type Action = { tool: string; input: unknown; ok: boolean };

function systemPrompt(ctx: ToolContext, email: string | null) {
  const now = new Date();
  return [
    "You are Ava, a hands-free voice personal assistant. Your replies are spoken aloud by a speech synthesiser, so:",
    "- Answer in 1-3 short sentences of plain conversational prose. No markdown, bullet points, emoji, URLs or code.",
    "- Speak dates and times naturally (\"tomorrow at half past two\", not \"2026-09-08T14:30:00Z\").",
    "- When reading back a list (events, emails, reminders), summarise the most important 3 and offer more.",
    "",
    "Tool use:",
    "- Call get_current_time before reasoning about any relative date such as \"tomorrow\" or \"next week\".",
    "- Prefer acting over asking. If a request is clear, do it and confirm briefly in the past tense.",
    "- Ask one short clarifying question only when a required detail is genuinely missing.",
    "",
    "Irreversible actions (send_email, create_calendar_event with attendees, delete_calendar_event):",
    "- Read the key details back and wait for the user's explicit yes in a later turn before calling the tool.",
    "- If the user hesitates, offer create_email_draft instead.",
    "",
    `Current time: ${now.toISOString()} (${now.toLocaleString("en-US", { timeZone: ctx.timezone, dateStyle: "full", timeStyle: "short" })}).`,
    `User's timezone: ${ctx.timezone}.`,
    ctx.google
      ? `The user's Google account (${email ?? "unknown address"}) is connected — Gmail and Calendar tools work.`
      : "The user's Google account is NOT connected. Calendar and Gmail tools will fail; tell them to tap Connect Google.",
  ].join("\n");
}

export async function POST(request: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "ANTHROPIC_API_KEY is not set. Add it to .env.local and restart." }, { status: 500 });
  }

  let body: { messages?: ChatTurn[]; timezone?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const history = (body.messages ?? []).filter((m) => m.content?.trim()).slice(-20);
  if (history.length === 0) {
    return NextResponse.json({ error: "No messages provided." }, { status: 400 });
  }

  const session = await readSession();
  const google = GoogleClient.fromSession(session);
  const ctx: ToolContext = { google, timezone: body.timezone || "UTC" };

  const client = new Anthropic();
  const messages: Anthropic.MessageParam[] = history.map((m) => ({ role: m.role, content: m.content }));
  const actions: Action[] = [];

  let reply = "";

  try {
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 2048,
        system: systemPrompt(ctx, session.google?.email ?? null),
        tools,
        messages,
      });

      reply = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join(" ")
        .trim();

      if (response.stop_reason !== "tool_use") break;

      const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      messages.push({ role: "assistant", content: response.content });

      const results: Anthropic.ToolResultBlockParam[] = await Promise.all(
        toolUses.map(async (block) => {
          try {
            const output = await runTool(block.name, block.input, ctx);
            actions.push({ tool: block.name, input: block.input, ok: true });
            return { type: "tool_result" as const, tool_use_id: block.id, content: output };
          } catch (e) {
            actions.push({ tool: block.name, input: block.input, ok: false });
            return {
              type: "tool_result" as const,
              tool_use_id: block.id,
              content: e instanceof Error ? e.message : "Tool failed.",
              is_error: true,
            };
          }
        }),
      );

      messages.push({ role: "user", content: results });
    }
  } catch (e) {
    const message =
      e instanceof Anthropic.APIError
        ? `Claude API error (${e.status}): ${e.message}`
        : e instanceof Error
          ? e.message
          : "Unknown error";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  const payload = NextResponse.json({
    reply: reply || "Sorry, I did not catch that. Could you say it again?",
    actions,
  });

  // The Google access token may have been refreshed mid-request — persist it.
  if (google?.dirty) {
    payload.cookies.set(sessionCookie({ ...session, google: google.current }));
  }
  return payload;
}

import type Anthropic from "@anthropic-ai/sdk";
import { GoogleClient } from "./google";
import { addReminder, completeReminder, deleteReminder, listReminders } from "./reminders";

export type ToolContext = {
  google: GoogleClient | null;
  timezone: string;
};

export const tools: Anthropic.Tool[] = [
  {
    name: "get_current_time",
    description:
      "Get the current date and time in the user's timezone. Use this before any relative date reasoning (\"tomorrow\", \"next Friday\").",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_calendar_events",
    description:
      "List upcoming events from the user's primary Google Calendar within a time range. Use it to answer questions about the schedule and to check for conflicts before creating an event.",
    input_schema: {
      type: "object",
      properties: {
        time_min: { type: "string", description: "RFC3339 start of range, e.g. 2026-09-07T00:00:00Z. Defaults to now." },
        time_max: { type: "string", description: "RFC3339 end of range. Defaults to 7 days after time_min." },
        query: { type: "string", description: "Optional free-text search over event fields." },
        max_results: { type: "integer", description: "Max events to return (default 10, max 50)." },
      },
      required: [],
    },
  },
  {
    name: "create_calendar_event",
    description:
      "Create an event on the user's primary Google Calendar. Always confirm the details with the user out loud before calling this.",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Event title." },
        start: { type: "string", description: "RFC3339 start datetime, or YYYY-MM-DD for an all-day event." },
        end: { type: "string", description: "RFC3339 end datetime, or YYYY-MM-DD for an all-day event. Defaults to one hour after start." },
        description: { type: "string" },
        location: { type: "string" },
        attendees: { type: "array", items: { type: "string" }, description: "Email addresses to invite." },
      },
      required: ["summary", "start"],
    },
  },
  {
    name: "delete_calendar_event",
    description: "Delete an event from the primary calendar by its event id (get the id from list_calendar_events first).",
    input_schema: {
      type: "object",
      properties: { event_id: { type: "string" } },
      required: ["event_id"],
    },
  },
  {
    name: "search_email",
    description:
      "Search the user's Gmail and return message summaries (id, from, subject, date, snippet). Supports Gmail search syntax, e.g. 'is:unread from:boss newer_than:2d'.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Gmail search query. Use 'in:inbox' or 'is:unread' for general asks." },
        max_results: { type: "integer", description: "Default 5, max 20. Keep it small — results are read aloud." },
      },
      required: ["query"],
    },
  },
  {
    name: "read_email",
    description: "Read the full plain-text body of one Gmail message by id.",
    input_schema: {
      type: "object",
      properties: { message_id: { type: "string" } },
      required: ["message_id"],
    },
  },
  {
    name: "create_email_draft",
    description:
      "Save a Gmail draft without sending it. Prefer this when the user is unsure, or as a safe fallback if they decline to send.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address(es), comma separated." },
        subject: { type: "string" },
        body: { type: "string" },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "send_email",
    description:
      "Send an email from the user's Gmail account. This is irreversible: read the recipient, subject and body back to the user and get an explicit yes in the previous turn before calling it.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address(es), comma separated." },
        subject: { type: "string" },
        body: { type: "string" },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "add_reminder",
    description: "Add a reminder or to-do to the assistant's own local list (not Google). Use for 'remind me to ...' requests.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "What to be reminded about." },
        due: { type: "string", description: "Optional RFC3339 due datetime." },
      },
      required: ["text"],
    },
  },
  {
    name: "list_reminders",
    description: "List the user's saved reminders.",
    input_schema: {
      type: "object",
      properties: { include_done: { type: "boolean", description: "Include completed reminders (default false)." } },
      required: [],
    },
  },
  {
    name: "complete_reminder",
    description: "Mark a reminder done, by id or by a distinctive phrase from its text.",
    input_schema: {
      type: "object",
      properties: { id_or_text: { type: "string" } },
      required: ["id_or_text"],
    },
  },
  {
    name: "delete_reminder",
    description: "Delete a reminder by id.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
];

/* ---------------------------------------------------------------- helpers */

const CAL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

function needsGoogle(ctx: ToolContext): GoogleClient {
  if (!ctx.google) {
    throw new Error("Google account is not connected. Ask the user to tap Connect Google in the app.");
  }
  return ctx.google;
}

const isDateOnly = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);

function calendarTime(value: string, timezone: string) {
  return isDateOnly(value) ? { date: value } : { dateTime: value, timeZone: timezone };
}

type CalendarEvent = {
  id: string;
  summary?: string;
  location?: string;
  description?: string;
  htmlLink?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: { email: string; responseStatus?: string }[];
};

type GmailHeader = { name: string; value: string };
type GmailPart = {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
};
type GmailMessage = { id: string; threadId: string; snippet?: string; payload?: GmailPart };

function header(msg: GmailMessage, name: string) {
  return msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function decodeBody(part?: GmailPart): string {
  if (!part) return "";
  if (part.body?.data) {
    const text = Buffer.from(part.body.data, "base64url").toString("utf8");
    return part.mimeType === "text/html" ? text.replace(/<[^>]+>/g, " ") : text;
  }
  if (part.parts) {
    const plain = part.parts.find((p) => p.mimeType === "text/plain");
    if (plain) return decodeBody(plain);
    const html = part.parts.find((p) => p.mimeType === "text/html");
    if (html) return decodeBody(html);
    return part.parts.map(decodeBody).join("\n");
  }
  return "";
}

function rfc822(to: string, subject: string, body: string) {
  const lines = [
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    body,
  ];
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}

const clamp = (n: unknown, fallback: number, max: number) =>
  Math.min(typeof n === "number" && n > 0 ? n : fallback, max);

/* --------------------------------------------------------------- dispatch */

export async function runTool(name: string, rawInput: unknown, ctx: ToolContext): Promise<string> {
  const input = (rawInput ?? {}) as Record<string, never>;
  const str = (k: string) => input[k] as unknown as string | undefined;

  switch (name) {
    case "get_current_time": {
      const now = new Date();
      return JSON.stringify({
        iso: now.toISOString(),
        local: now.toLocaleString("en-US", { timeZone: ctx.timezone, dateStyle: "full", timeStyle: "short" }),
        timezone: ctx.timezone,
      });
    }

    case "list_calendar_events": {
      const google = needsGoogle(ctx);
      const timeMin = str("time_min") ?? new Date().toISOString();
      const timeMax = str("time_max") ?? new Date(Date.parse(timeMin) + 7 * 864e5).toISOString();
      const params = new URLSearchParams({
        timeMin,
        timeMax,
        singleEvents: "true",
        orderBy: "startTime",
        maxResults: String(clamp(input["max_results"], 10, 50)),
        timeZone: ctx.timezone,
      });
      const q = str("query");
      if (q) params.set("q", q);
      const data = await google.request<{ items?: CalendarEvent[] }>(`${CAL}?${params}`);
      const events = (data.items ?? []).map((e) => ({
        id: e.id,
        title: e.summary ?? "(no title)",
        start: e.start?.dateTime ?? e.start?.date,
        end: e.end?.dateTime ?? e.end?.date,
        location: e.location,
        attendees: e.attendees?.map((a) => a.email),
      }));
      return JSON.stringify({ count: events.length, events });
    }

    case "create_calendar_event": {
      const google = needsGoogle(ctx);
      const start = str("start")!;
      const end =
        str("end") ??
        (isDateOnly(start) ? start : new Date(Date.parse(start) + 3600_000).toISOString());
      const attendees = (input["attendees"] as unknown as string[] | undefined)?.map((email) => ({ email }));
      const created = await google.request<CalendarEvent>(CAL, {
        method: "POST",
        body: JSON.stringify({
          summary: str("summary"),
          description: str("description"),
          location: str("location"),
          start: calendarTime(start, ctx.timezone),
          end: calendarTime(end, ctx.timezone),
          ...(attendees?.length ? { attendees } : {}),
        }),
      });
      return JSON.stringify({
        created: true,
        id: created.id,
        title: created.summary,
        start: created.start?.dateTime ?? created.start?.date,
        link: created.htmlLink,
      });
    }

    case "delete_calendar_event": {
      const google = needsGoogle(ctx);
      await google.request(`${CAL}/${encodeURIComponent(str("event_id")!)}`, { method: "DELETE" });
      return JSON.stringify({ deleted: true });
    }

    case "search_email": {
      const google = needsGoogle(ctx);
      const params = new URLSearchParams({
        q: str("query") ?? "in:inbox",
        maxResults: String(clamp(input["max_results"], 5, 20)),
      });
      const list = await google.request<{ messages?: { id: string }[] }>(`${GMAIL}/messages?${params}`);
      const ids = (list.messages ?? []).map((m) => m.id);
      const messages = await Promise.all(
        ids.map(async (id) => {
          const msg = await google.request<GmailMessage>(
            `${GMAIL}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
          );
          return {
            id: msg.id,
            from: header(msg, "From"),
            subject: header(msg, "Subject"),
            date: header(msg, "Date"),
            snippet: msg.snippet,
          };
        }),
      );
      return JSON.stringify({ count: messages.length, messages });
    }

    case "read_email": {
      const google = needsGoogle(ctx);
      const msg = await google.request<GmailMessage>(
        `${GMAIL}/messages/${encodeURIComponent(str("message_id")!)}?format=full`,
      );
      const body = decodeBody(msg.payload).replace(/\s+\n/g, "\n").trim();
      return JSON.stringify({
        from: header(msg, "From"),
        to: header(msg, "To"),
        subject: header(msg, "Subject"),
        date: header(msg, "Date"),
        body: body.slice(0, 6000),
        truncated: body.length > 6000,
      });
    }

    case "create_email_draft": {
      const google = needsGoogle(ctx);
      const draft = await google.request<{ id: string }>(`${GMAIL}/drafts`, {
        method: "POST",
        body: JSON.stringify({ message: { raw: rfc822(str("to")!, str("subject")!, str("body")!) } }),
      });
      return JSON.stringify({ draft_saved: true, draft_id: draft.id });
    }

    case "send_email": {
      const google = needsGoogle(ctx);
      const sent = await google.request<{ id: string }>(`${GMAIL}/messages/send`, {
        method: "POST",
        body: JSON.stringify({ raw: rfc822(str("to")!, str("subject")!, str("body")!) }),
      });
      return JSON.stringify({ sent: true, message_id: sent.id, to: str("to") });
    }

    case "add_reminder":
      return JSON.stringify(await addReminder(str("text")!, str("due")));

    case "list_reminders":
      return JSON.stringify({ reminders: await listReminders(Boolean(input["include_done"])) });

    case "complete_reminder": {
      const done = await completeReminder(str("id_or_text")!);
      return JSON.stringify(done ? { completed: true, reminder: done } : { completed: false, reason: "no match" });
    }

    case "delete_reminder":
      return JSON.stringify({ deleted: await deleteReminder(str("id")!) });

    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

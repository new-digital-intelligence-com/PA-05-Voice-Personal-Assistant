/**
 * Turns raw tool output into structured cards the UI can render, so answers are
 * not just a wall of spoken text.
 */

export type EventItem = { id: string; title: string; start?: string; end?: string; location?: string };
export type EmailItem = { id: string; from: string; subject: string; date?: string; snippet?: string };
export type ReminderItem = { id: string; text: string; due?: string; done: boolean };

export type Card =
  | { type: "events"; items: EventItem[] }
  | { type: "emails"; items: EmailItem[] }
  | { type: "reminders"; items: ReminderItem[] }
  | { type: "email_body"; from: string; subject: string; date?: string; body: string }
  | { type: "confirmation"; tone: "success" | "warning"; title: string; detail?: string; link?: string };

type Json = Record<string, unknown>;

const asArray = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

export function toCards(toolName: string, output: string): Card[] {
  let data: Json;
  try {
    data = JSON.parse(output) as Json;
  } catch {
    return [];
  }

  switch (toolName) {
    case "list_calendar_events": {
      const items = asArray<EventItem>(data.events);
      return items.length ? [{ type: "events", items }] : [];
    }

    case "search_email": {
      const items = asArray<EmailItem>(data.messages);
      return items.length ? [{ type: "emails", items }] : [];
    }

    case "list_reminders": {
      const items = asArray<ReminderItem>(data.reminders);
      return items.length ? [{ type: "reminders", items }] : [];
    }

    case "read_email":
      return [
        {
          type: "email_body",
          from: asString(data.from) ?? "",
          subject: asString(data.subject) ?? "(no subject)",
          date: asString(data.date),
          body: asString(data.body) ?? "",
        },
      ];

    case "create_calendar_event":
      return [
        {
          type: "confirmation",
          tone: "success",
          title: `Added “${asString(data.title) ?? "event"}” to your calendar`,
          detail: asString(data.start),
          link: asString(data.link),
        },
      ];

    case "delete_calendar_event":
      return [{ type: "confirmation", tone: "warning", title: "Event deleted" }];

    case "send_email":
      return [
        {
          type: "confirmation",
          tone: "success",
          title: `Email sent to ${asString(data.to) ?? "recipient"}`,
        },
      ];

    case "create_email_draft":
      return [{ type: "confirmation", tone: "warning", title: "Draft saved — not sent" }];

    case "add_reminder":
      return [
        {
          type: "confirmation",
          tone: "success",
          title: `Reminder: ${asString(data.text) ?? ""}`,
          detail: asString(data.due),
        },
      ];

    case "complete_reminder":
      return data.completed
        ? [{ type: "confirmation", tone: "success", title: "Reminder completed" }]
        : [];

    default:
      return [];
  }
}

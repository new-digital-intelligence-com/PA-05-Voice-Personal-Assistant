"use client";

import type { Card, EmailItem, EventItem, ReminderItem } from "@/lib/cards";

function formatWhen(value?: string) {
  if (!value) return "";
  // Date-only values are all-day events.
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(`${value}T00:00:00`).toLocaleDateString(undefined, {
      weekday: "short",
      day: "numeric",
      month: "short",
    });
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  const tomorrow = new Date(today.getTime() + 864e5).toDateString() === date.toDateString();
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (sameDay) return `Today · ${time}`;
  if (tomorrow) return `Tomorrow · ${time}`;
  return `${date.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })} · ${time}`;
}

function senderName(from: string) {
  const match = from.match(/^\s*"?([^"<]+?)"?\s*</);
  return (match ? match[1] : from.replace(/[<>]/g, "")).trim();
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

const Panel = ({ children }: { children: React.ReactNode }) => (
  <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.04] backdrop-blur-md">
    {children}
  </div>
);

const Label = ({ children }: { children: React.ReactNode }) => (
  <p className="px-4 pt-3 text-[11px] font-medium uppercase tracking-wider text-slate-500">{children}</p>
);

function EventRow({ event }: { event: EventItem }) {
  return (
    <div className="flex gap-3 px-4 py-2.5">
      <div className="mt-1 h-full w-0.5 shrink-0 rounded-full bg-indigo-400/70" />
      <div className="min-w-0">
        <p className="truncate text-sm text-slate-100">{event.title}</p>
        <p className="text-xs text-slate-400">
          {formatWhen(event.start)}
          {event.location ? ` · ${event.location}` : ""}
        </p>
      </div>
    </div>
  );
}

function EmailRow({ email }: { email: EmailItem }) {
  const name = senderName(email.from);
  return (
    <div className="flex gap-3 px-4 py-2.5">
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-sky-400/30 to-indigo-400/30 text-[10px] font-semibold text-sky-200">
        {initials(name)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <p className="truncate text-sm text-slate-100">{name}</p>
          <p className="shrink-0 text-[10px] text-slate-500">
            {email.date ? new Date(email.date).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : ""}
          </p>
        </div>
        <p className="truncate text-xs text-slate-300">{email.subject}</p>
        {email.snippet && <p className="mt-0.5 line-clamp-2 text-xs text-slate-500">{email.snippet}</p>}
      </div>
    </div>
  );
}

function ReminderRow({ reminder }: { reminder: ReminderItem }) {
  return (
    <div className="flex items-start gap-3 px-4 py-2.5">
      <span
        className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
          reminder.done ? "bg-slate-600" : "bg-amber-400"
        }`}
      />
      <div className="min-w-0">
        <p className={`text-sm ${reminder.done ? "text-slate-500 line-through" : "text-slate-100"}`}>
          {reminder.text}
        </p>
        {reminder.due && <p className="text-xs text-slate-400">{formatWhen(reminder.due)}</p>}
      </div>
    </div>
  );
}

export default function CardView({ card }: { card: Card }) {
  switch (card.type) {
    case "events":
      return (
        <Panel>
          <Label>Calendar</Label>
          <div className="divide-y divide-white/5 pb-1">
            {card.items.map((event) => (
              <EventRow key={event.id} event={event} />
            ))}
          </div>
        </Panel>
      );

    case "emails":
      return (
        <Panel>
          <Label>Inbox</Label>
          <div className="divide-y divide-white/5 pb-1">
            {card.items.map((email) => (
              <EmailRow key={email.id} email={email} />
            ))}
          </div>
        </Panel>
      );

    case "reminders":
      return (
        <Panel>
          <Label>Reminders</Label>
          <div className="divide-y divide-white/5 pb-1">
            {card.items.map((reminder) => (
              <ReminderRow key={reminder.id} reminder={reminder} />
            ))}
          </div>
        </Panel>
      );

    case "email_body":
      return (
        <Panel>
          <div className="px-4 py-3">
            <p className="text-xs text-slate-400">{senderName(card.from)}</p>
            <p className="text-sm font-medium text-slate-100">{card.subject}</p>
            <p className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed text-slate-400">
              {card.body.slice(0, 1200)}
            </p>
          </div>
        </Panel>
      );

    case "confirmation":
      return (
        <div
          className={`flex items-center gap-2.5 rounded-2xl border px-4 py-2.5 backdrop-blur-md ${
            card.tone === "success"
              ? "border-emerald-400/25 bg-emerald-400/10"
              : "border-amber-400/25 bg-amber-400/10"
          }`}
        >
          <span className={card.tone === "success" ? "text-emerald-300" : "text-amber-300"}>
            {card.tone === "success" ? "✓" : "•"}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm text-slate-100">{card.title}</p>
            {card.detail && <p className="text-xs text-slate-400">{formatWhen(card.detail)}</p>}
          </div>
        </div>
      );

    default:
      return null;
  }
}

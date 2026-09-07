import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export type Reminder = {
  id: string;
  text: string;
  /** ISO 8601, optional — a reminder can be a plain to-do */
  due?: string;
  done: boolean;
  createdAt: string;
};

const FILE = path.join(process.cwd(), "data", "reminders.json");

async function readAll(): Promise<Reminder[]> {
  try {
    return JSON.parse(await fs.readFile(FILE, "utf8")) as Reminder[];
  } catch {
    return [];
  }
}

async function writeAll(items: Reminder[]) {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(items, null, 2), "utf8");
}

export async function addReminder(text: string, due?: string): Promise<Reminder> {
  const items = await readAll();
  const reminder: Reminder = {
    id: crypto.randomUUID().slice(0, 8),
    text,
    due,
    done: false,
    createdAt: new Date().toISOString(),
  };
  items.push(reminder);
  await writeAll(items);
  return reminder;
}

export async function listReminders(includeDone = false): Promise<Reminder[]> {
  const items = await readAll();
  return items
    .filter((r) => includeDone || !r.done)
    .sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999"));
}

export async function completeReminder(id: string): Promise<Reminder | null> {
  const items = await readAll();
  const match = items.find((r) => r.id === id || r.text.toLowerCase().includes(id.toLowerCase()));
  if (!match) return null;
  match.done = true;
  await writeAll(items);
  return match;
}

export async function deleteReminder(id: string): Promise<boolean> {
  const items = await readAll();
  const next = items.filter((r) => r.id !== id);
  if (next.length === items.length) return false;
  await writeAll(next);
  return true;
}

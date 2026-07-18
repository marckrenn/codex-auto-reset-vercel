import { Client, Receiver } from "@upstash/qstash";
import type { StateStore } from "./service";

const SCHEDULE_KEY = "qstash-schedule";

export type StoredSchedule = {
  scheduleId: string;
  destination: string;
};

function qstashClient(): Client {
  const token = process.env.QSTASH_TOKEN;
  if (!token) throw new Error("Upstash QStash is not configured");
  return new Client({ token, baseUrl: process.env.QSTASH_URL });
}

export function qstashReceiver(): Receiver {
  const currentSigningKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY;
  if (!currentSigningKey || !nextSigningKey) throw new Error("QStash signing keys are not configured");
  return new Receiver({ currentSigningKey, nextSigningKey });
}

export async function ensureSchedule(store: StateStore, origin: string): Promise<StoredSchedule> {
  const destination = new URL("/cron", origin).toString();
  if (!destination.startsWith("https://")) throw new Error("QStash destination must use HTTPS");

  const existing = await store.get<StoredSchedule>(SCHEDULE_KEY);
  if (existing?.scheduleId && existing.destination === destination) return existing;

  const client = qstashClient();
  if (existing?.scheduleId) {
    await client.schedules.delete(existing.scheduleId).catch(() => undefined);
  }

  const created = await client.schedules.create({
    destination,
    cron: "*/5 * * * *",
    method: "POST",
    body: "{}",
    headers: { "Content-Type": "application/json" },
    retries: 2,
    redact: { body: true, header: true },
  });
  const schedule = { scheduleId: created.scheduleId, destination };
  await store.put(SCHEDULE_KEY, schedule);
  return schedule;
}

export async function deleteSchedule(store: StateStore): Promise<void> {
  const existing = await store.get<StoredSchedule>(SCHEDULE_KEY);
  if (existing?.scheduleId) {
    await qstashClient().schedules.delete(existing.scheduleId).catch(() => undefined);
  }
  await store.delete(SCHEDULE_KEY);
}

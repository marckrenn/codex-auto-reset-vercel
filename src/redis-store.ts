import { Redis } from "@upstash/redis";
import type { StateStore } from "./service";

const PREFIX = "codex-auto-reset:v1:";
const LOCK_KEY = `${PREFIX}operation-lock`;
const LOCK_TTL_MS = 65_000;

export class OperationBusyError extends Error {
  constructor() {
    super("Another operation is already running");
    this.name = "OperationBusyError";
  }
}

export function redisClient(): Redis {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error("Upstash Redis is not configured");
  return new Redis({ url, token });
}

export class RedisStateStore implements StateStore {
  constructor(private readonly redis: Redis) {}

  async get<T>(key: string): Promise<T | undefined> {
    return (await this.redis.get<T>(`${PREFIX}${key}`)) ?? undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    await this.redis.set(`${PREFIX}${key}`, value);
  }

  async delete(key: string): Promise<boolean> {
    return (await this.redis.del(`${PREFIX}${key}`)) > 0;
  }
}

export async function withOperationLock<T>(redis: Redis, work: () => Promise<T>): Promise<T> {
  const token = crypto.randomUUID();
  const acquired = await redis.set(LOCK_KEY, token, { nx: true, px: LOCK_TTL_MS });
  if (acquired !== "OK") throw new OperationBusyError();

  try {
    return await work();
  } finally {
    await redis.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      [LOCK_KEY],
      [token],
    ).catch(() => undefined);
  }
}

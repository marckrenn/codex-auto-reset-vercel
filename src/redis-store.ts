import { Redis } from "@upstash/redis";
import type { StateStore } from "./service";

const BASE_PREFIX = "codex-auto-reset:v1:";
const LOCK_TTL_MS = 65_000;

export function statePrefix(environment: NodeJS.ProcessEnv = process.env): string {
  const namespace = environment.STATE_NAMESPACE?.trim();
  if (!namespace) return BASE_PREFIX;
  if (!/^[a-zA-Z0-9_-]{1,48}$/.test(namespace)) {
    throw new Error("STATE_NAMESPACE must contain only letters, numbers, underscores, and hyphens");
  }
  return `${BASE_PREFIX}${namespace}:`;
}

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
  private readonly prefix: string;

  constructor(private readonly redis: Redis, environment: NodeJS.ProcessEnv = process.env) {
    this.prefix = statePrefix(environment);
  }

  async get<T>(key: string): Promise<T | undefined> {
    return (await this.redis.get<T>(`${this.prefix}${key}`)) ?? undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    await this.redis.set(`${this.prefix}${key}`, value);
  }

  async delete(key: string): Promise<boolean> {
    return (await this.redis.del(`${this.prefix}${key}`)) > 0;
  }
}

export async function withOperationLock<T>(redis: Redis, work: () => Promise<T>): Promise<T> {
  const token = crypto.randomUUID();
  const lockKey = `${statePrefix()}operation-lock`;
  const acquired = await redis.set(lockKey, token, { nx: true, px: LOCK_TTL_MS });
  if (acquired !== "OK") throw new OperationBusyError();

  try {
    return await work();
  } finally {
    await redis.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      [lockKey],
      [token],
    ).catch(() => undefined);
  }
}

import { describe, expect, test } from "bun:test";
import { decryptJson, encryptJson, type EncryptedValue } from "../src/crypto";
import type { DeviceFlow, OAuthCredential } from "../src/oauth";
import { advanceSetup, beginSetup, getServiceView, runScheduledReset, type StateStore } from "../src/service";

const masterKey = "m".repeat(32);
const now = Date.parse("2026-07-18T12:00:00Z");

class MemoryStore implements StateStore {
  values = new Map<string, unknown>();
  events: string[] = [];

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.events.push(`put:${key}`);
    this.values.set(key, structuredClone(value));
  }

  async delete(key: string): Promise<boolean> {
    this.events.push(`delete:${key}`);
    return this.values.delete(key);
  }
}

const credential: OAuthCredential = {
  type: "oauth",
  access: "old-access",
  refresh: "old-refresh",
  expires: now + 60 * 60_000,
  accountId: "account-1",
};

async function seedCredential(store: MemoryStore, value = credential): Promise<void> {
  store.values.set("credential", await encryptJson(value, masterKey));
}

function dueInventory() {
  return { credits: [{ id: "credit-1", status: "available", expires_at: "2026-07-18T12:05:00Z" }] };
}

describe("persistent reset service state", () => {
  test("stores completed device login encrypted and removes temporary flow state", async () => {
    const store = new MemoryStore();
    const encode = (value: unknown) => btoa(JSON.stringify(value)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    const jwt = `${encode({ alg: "none" })}.${encode({ "https://api.openai.com/auth": { chatgpt_account_id: "account-1" } })}.signature`;
    const fetch = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("/deviceauth/usercode")) {
        return Response.json({ device_auth_id: "device-secret", user_code: "ABCD-EFGH", interval: 1 });
      }
      if (url.endsWith("/deviceauth/token")) {
        return Response.json({ authorization_code: "code", code_verifier: "verifier" });
      }
      return Response.json({ access_token: jwt, refresh_token: "refresh-secret", expires_in: 3600 });
    };

    await beginSetup(store, masterKey, { now: () => now, oauth: { fetch } });
    expect(JSON.stringify(store.values.get("device-flow"))).not.toContain("device-secret");
    expect(await advanceSetup(store, masterKey, {
      now: () => now,
      oauth: { fetch },
      wham: {
        fetch: async () => Response.json({
          credits: [
            { id: "credit-1", status: "available", expires_at: "2026-07-20T12:00:00Z" },
            { id: "credit-2", status: "available", expires_at: "2026-07-21T12:00:00Z" },
          ],
        }),
      },
    })).toBe("configured");
    expect(store.values.has("device-flow")).toBeFalse();
    expect(JSON.stringify(store.values.get("credential"))).not.toContain("refresh-secret");
    const view = await getServiceView(store, masterKey);
    expect(view.summary).toMatchObject({
      availableCount: 2,
      availableCredits: [
        { expiresAt: "2026-07-20T12:00:00Z" },
        { expiresAt: "2026-07-21T12:00:00Z" },
      ],
      nextExpiry: "2026-07-20T12:00:00Z",
      lastCheckAt: "2026-07-18T12:00:00.000Z",
      lastResult: "OAuth setup completed; credits loaded",
    });
  });

  test("persists the next device poll deadline before a network failure", async () => {
    const store = new MemoryStore();
    await beginSetup(store, masterKey, {
      now: () => now,
      oauth: {
        fetch: async () => Response.json({ device_auth_id: "device-secret", user_code: "ABCD-EFGH", interval: 2 }),
      },
    });

    await expect(advanceSetup(store, masterKey, {
      now: () => now,
      oauth: { fetch: async () => { throw new Error("network down"); } },
    })).rejects.toThrow();

    const encrypted = store.values.get("device-flow") as EncryptedValue;
    const flow = await decryptJson<DeviceFlow>(encrypted, masterKey);
    expect(flow.nextPollAt).toBe(now + 2_000);
  });

  test("does nothing when OAuth is not configured", async () => {
    const store = new MemoryStore();
    let fetched = false;
    await runScheduledReset(store, masterKey, {
      now: () => now,
      wham: { fetch: async () => { fetched = true; throw new Error("must not fetch"); } },
    });
    expect(fetched).toBeFalse();
    expect(store.values.size).toBe(0);
  });

  test("persists one UUID before POST and reuses it after an ambiguous failure", async () => {
    const store = new MemoryStore();
    await seedCredential(store);
    let postAttempts = 0;
    const postedIds: string[] = [];
    const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (!url.endsWith("/consume")) return Response.json(dueInventory());
      postAttempts += 1;
      postedIds.push(JSON.parse(String(init?.body)).redeem_request_id);
      store.events.push("fetch:consume");
      if (postAttempts === 1) throw new Error("ambiguous network failure");
      return Response.json({ code: "reset" });
    };

    await expect(runScheduledReset(store, masterKey, {
      now: () => now,
      uuid: () => "stable-uuid",
      wham: { fetch },
    })).rejects.toThrow("Scheduled reset check failed");

    expect(store.events.indexOf("put:attempts")).toBeLessThan(store.events.indexOf("fetch:consume"));
    expect((store.values.get("attempts") as Record<string, { status: string }>)["credit-1"]?.status).toBe("pending");
    expect((store.values.get("summary") as { lastResult: string }).lastResult).toBe("WHAM consume request failed; it will retry");

    await runScheduledReset(store, masterKey, {
      now: () => now,
      uuid: () => "must-not-be-used",
      wham: { fetch },
    });

    expect(postedIds).toEqual(["stable-uuid", "stable-uuid"]);
    expect((store.values.get("attempts") as Record<string, { status: string }>)["credit-1"]?.status).toBe("consumed");
  });

  test("persists rotated OAuth credentials before fetching inventory", async () => {
    const store = new MemoryStore();
    await seedCredential(store, { ...credential, expires: 0 });
    const events: string[] = [];
    store.events = events;

    await runScheduledReset(store, masterKey, {
      now: () => now,
      oauth: {
        fetch: async () => {
          events.push("fetch:refresh");
          return Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 });
        },
      },
      wham: {
        fetch: async () => {
          events.push("fetch:inventory");
          return Response.json({ credits: [] });
        },
      },
    });

    expect(events.indexOf("put:credential")).toBeLessThan(events.indexOf("fetch:inventory"));
    const encrypted = store.values.get("credential") as EncryptedValue;
    const rotated = await decryptJson<OAuthCredential>(encrypted, masterKey);
    expect(rotated.refresh).toBe("new-refresh");
  });
});

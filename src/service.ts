import { assertMasterKey } from "./config";
import { decryptJson, encryptJson, type EncryptedValue } from "./crypto";
import { RemoteRequestError } from "./http";
import {
  oauthNeedsRefresh,
  pollDeviceFlow,
  refreshOAuthCredential,
  startDeviceFlow,
  type DeviceFlow,
  type OAuthCredential,
  type OAuthOptions,
} from "./oauth";
import { earliestAvailableExpiry, selectDueCredit, type ResetCredit } from "./schedule";
import { consumeResetCredit, getResetCredits, type WhamOptions } from "./wham";

const CREDENTIAL_KEY = "credential";
const DEVICE_FLOW_KEY = "device-flow";
const ATTEMPTS_KEY = "attempts";
const SUMMARY_KEY = "summary";

export type Attempt = {
  redeemRequestId: string;
  status: "pending" | "consumed";
  updatedAt: string;
};

export type Attempts = Record<string, Attempt>;

export type SafeSummary = {
  configured: boolean;
  lastCheckAt?: string;
  availableCount?: number;
  availableCredits?: Array<{ expiresAt: string }>;
  nextExpiry?: string;
  lastResult?: string;
};

export type ServiceView = {
  configured: boolean;
  deviceFlow?: {
    userCode: string;
    expiresAt: number;
    nextPollAt: number;
    intervalMs: number;
  };
  summary: SafeSummary;
};

export interface StateStore {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export type ServiceDependencies = {
  now: () => number;
  uuid: () => string;
  oauth: OAuthOptions;
  wham: WhamOptions;
};

function defaultDependencies(): ServiceDependencies {
  return {
    now: Date.now,
    uuid: crypto.randomUUID,
    oauth: {},
    wham: {},
  };
}

function iso(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

function availableCreditSummary(credits: Array<{ status: string; expires_at: string }>, nowMs: number) {
  return credits
    .filter((credit) => credit.status === "available" && Date.parse(credit.expires_at) > nowMs)
    .sort((left, right) => Date.parse(left.expires_at) - Date.parse(right.expires_at))
    .map((credit) => ({ expiresAt: credit.expires_at }));
}

function safeOperationalError(error: unknown): string {
  if (error instanceof RemoteRequestError) return error.message;
  if (error instanceof Error && /^(OAuth|Stored OAuth|Unable to decrypt|Reset credit|Full reset)/.test(error.message)) {
    return error.message;
  }
  return "Remote check failed";
}

function parseCredential(value: OAuthCredential): OAuthCredential {
  if (value?.type !== "oauth"
    || typeof value.access !== "string" || value.access === ""
    || typeof value.refresh !== "string" || value.refresh === ""
    || typeof value.expires !== "number" || !Number.isFinite(value.expires)
    || typeof value.accountId !== "string" || value.accountId === "") {
    throw new Error("Stored OAuth credential is invalid");
  }
  return value;
}

async function loadCredential(store: StateStore, masterKey: string): Promise<OAuthCredential | undefined> {
  const encrypted = await store.get<EncryptedValue>(CREDENTIAL_KEY);
  return encrypted ? parseCredential(await decryptJson<OAuthCredential>(encrypted, masterKey)) : undefined;
}

async function saveCredential(store: StateStore, masterKey: string, credential: OAuthCredential): Promise<void> {
  await store.put(CREDENTIAL_KEY, await encryptJson(credential, masterKey));
}

async function loadDeviceFlow(store: StateStore, masterKey: string): Promise<DeviceFlow | undefined> {
  const encrypted = await store.get<EncryptedValue>(DEVICE_FLOW_KEY);
  return encrypted ? decryptJson<DeviceFlow>(encrypted, masterKey) : undefined;
}

async function saveDeviceFlow(store: StateStore, masterKey: string, flow: DeviceFlow): Promise<void> {
  await store.put(DEVICE_FLOW_KEY, await encryptJson(flow, masterKey));
}

export async function getServiceView(store: StateStore, masterKey: string): Promise<ServiceView> {
  assertMasterKey(masterKey);
  const [credential, flow, storedSummary] = await Promise.all([
    loadCredential(store, masterKey),
    loadDeviceFlow(store, masterKey),
    store.get<SafeSummary>(SUMMARY_KEY),
  ]);
  const configured = credential !== undefined;
  return {
    configured,
    ...(flow ? {
      deviceFlow: {
        userCode: flow.userCode,
        expiresAt: flow.expiresAt,
        nextPollAt: flow.nextPollAt,
        intervalMs: flow.intervalMs,
      },
    } : {}),
    summary: { ...storedSummary, configured },
  };
}

export async function beginSetup(
  store: StateStore,
  masterKey: string,
  dependencies: Partial<ServiceDependencies> = {},
): Promise<ServiceView> {
  assertMasterKey(masterKey);
  if (await loadCredential(store, masterKey)) throw new Error("Service is already configured");
  const defaults = defaultDependencies();
  const now = dependencies.now ?? defaults.now;
  const flow = await startDeviceFlow({ ...defaults.oauth, ...dependencies.oauth, now });
  await saveDeviceFlow(store, masterKey, flow);
  await store.put<SafeSummary>(SUMMARY_KEY, { configured: false, lastResult: "Waiting for OpenAI device approval" });
  return getServiceView(store, masterKey);
}

export async function advanceSetup(
  store: StateStore,
  masterKey: string,
  dependencies: Partial<ServiceDependencies> = {},
): Promise<"pending" | "configured"> {
  assertMasterKey(masterKey);
  if (await loadCredential(store, masterKey)) return "configured";
  const flow = await loadDeviceFlow(store, masterKey);
  if (!flow) throw new Error("No device login is active");

  const defaults = defaultDependencies();
  const now = dependencies.now ?? defaults.now;
  const nowMs = now();
  if (nowMs >= flow.nextPollAt) {
    // Reserve the next allowed poll before network I/O so failures cannot cause a tight retry loop.
    await saveDeviceFlow(store, masterKey, { ...flow, nextPollAt: nowMs + flow.intervalMs });
  }
  try {
    const result = await pollDeviceFlow(flow, { ...defaults.oauth, ...dependencies.oauth, now: () => nowMs });
    if (result.status === "pending") {
      if (result.flow !== flow) await saveDeviceFlow(store, masterKey, result.flow);
      return "pending";
    }

    await saveCredential(store, masterKey, result.credential);
    await store.delete(DEVICE_FLOW_KEY);

    try {
      const credits = await getResetCredits(result.credential, {
        ...defaults.wham,
        ...dependencies.wham,
        now: () => nowMs,
      });
      const availableCredits = availableCreditSummary(credits, nowMs);
      await store.put<SafeSummary>(SUMMARY_KEY, {
        configured: true,
        lastCheckAt: iso(nowMs),
        availableCount: availableCredits.length,
        availableCredits,
        nextExpiry: earliestAvailableExpiry(credits, nowMs),
        lastResult: "OAuth setup completed; full resets loaded",
      });
    } catch (error) {
      // Authentication succeeded even if the optional first inventory read did not.
      await store.put<SafeSummary>(SUMMARY_KEY, {
        configured: true,
        lastCheckAt: iso(nowMs),
        lastResult: `OAuth setup completed; ${safeOperationalError(error)}`,
      });
    }
    return "configured";
  } catch (error) {
    if (error instanceof Error && error.message === "OAuth device flow expired") {
      await store.delete(DEVICE_FLOW_KEY);
      await store.put<SafeSummary>(SUMMARY_KEY, { configured: false, lastResult: "Device login expired; start again" });
    }
    throw error;
  }
}

export async function resetService(store: StateStore): Promise<void> {
  await Promise.all([
    store.delete(CREDENTIAL_KEY),
    store.delete(DEVICE_FLOW_KEY),
    store.delete(ATTEMPTS_KEY),
    store.delete(SUMMARY_KEY),
  ]);
}

async function storeInventorySummary(
  store: StateStore,
  credits: ResetCredit[],
  nowMs: number,
  lastResult: string,
): Promise<void> {
  const availableCredits = availableCreditSummary(credits, nowMs);
  await store.put<SafeSummary>(SUMMARY_KEY, {
    configured: true,
    lastCheckAt: iso(nowMs),
    availableCount: availableCredits.length,
    availableCredits,
    nextExpiry: earliestAvailableExpiry(credits, nowMs),
    lastResult,
  });
}

async function consumeAndRefresh(
  store: StateStore,
  credential: OAuthCredential,
  credit: ResetCredit,
  now: () => number,
  uuid: () => string,
  whamOptions: WhamOptions,
): Promise<{ credits: ResetCredit[]; resultCode?: string }> {
  const attempts = await store.get<Attempts>(ATTEMPTS_KEY) ?? {};
  const existing = attempts[credit.id];
  if (existing?.status === "consumed") throw new Error("Full reset was already used");
  const attempt: Attempt = existing ?? {
    redeemRequestId: uuid(),
    status: "pending",
    updatedAt: iso(now()),
  };
  attempts[credit.id] = attempt;
  // Persist the idempotency key before the mutating request.
  await store.put(ATTEMPTS_KEY, attempts);

  const expiresMs = Date.parse(credit.expires_at);
  if (now() >= expiresMs) throw new Error("Reset credit expired");
  const result = await consumeResetCredit(
    credential,
    credit.id,
    attempt.redeemRequestId,
    expiresMs,
    whamOptions,
  );

  attempts[credit.id] = { ...attempt, status: "consumed", updatedAt: iso(now()) };
  await store.put(ATTEMPTS_KEY, attempts);
  return { credits: await getResetCredits(credential, whamOptions), resultCode: result.code };
}

export async function consumeCreditByExpiry(
  store: StateStore,
  masterKey: string,
  expiresAt: string,
  dependencies: Partial<ServiceDependencies> = {},
): Promise<void> {
  assertMasterKey(masterKey);
  if (!Number.isFinite(Date.parse(expiresAt))) throw new Error("Full reset expiry is invalid");

  const defaults = defaultDependencies();
  const now = dependencies.now ?? defaults.now;
  const uuid = dependencies.uuid ?? defaults.uuid;
  const oauthOptions = { ...defaults.oauth, ...dependencies.oauth, now };
  const whamOptions = { ...defaults.wham, ...dependencies.wham, now };
  let credential = await loadCredential(store, masterKey);
  if (!credential) throw new Error("OAuth is not configured");

  try {
    if (oauthNeedsRefresh(credential, now())) {
      credential = await refreshOAuthCredential(credential, oauthOptions);
      await saveCredential(store, masterKey, credential);
    }

    const credits = await getResetCredits(credential, whamOptions);
    const matches = credits.filter((credit) => credit.status === "available" && credit.expires_at === expiresAt);
    if (matches.length !== 1) throw new Error("Full reset is no longer uniquely available");

    const consumed = await consumeAndRefresh(store, credential, matches[0]!, now, uuid, whamOptions);
    await storeInventorySummary(
      store,
      consumed.credits,
      now(),
      consumed.resultCode ? `Used full reset (${consumed.resultCode})` : "Used full reset",
    );
  } catch (error) {
    const previous = await store.get<SafeSummary>(SUMMARY_KEY);
    await store.put<SafeSummary>(SUMMARY_KEY, {
      ...previous,
      configured: true,
      lastCheckAt: iso(now()),
      lastResult: safeOperationalError(error),
    });
    throw new Error("Manual reset failed");
  }
}

export async function runScheduledReset(
  store: StateStore,
  masterKey: string,
  dependencies: Partial<ServiceDependencies> = {},
): Promise<void> {
  assertMasterKey(masterKey);
  const defaults = defaultDependencies();
  const now = dependencies.now ?? defaults.now;
  const uuid = dependencies.uuid ?? defaults.uuid;
  const oauthOptions = { ...defaults.oauth, ...dependencies.oauth, now };
  const whamOptions = { ...defaults.wham, ...dependencies.wham, now };
  let credential = await loadCredential(store, masterKey);
  if (!credential) return;

  const nowMs = now();
  try {
    if (oauthNeedsRefresh(credential, nowMs)) {
      credential = await refreshOAuthCredential(credential, oauthOptions);
      // A rotated refresh token must be durable before any subsequent request.
      await saveCredential(store, masterKey, credential);
    }

    let credits = await getResetCredits(credential, whamOptions);
    const attempts = await store.get<Attempts>(ATTEMPTS_KEY) ?? {};
    const consumedIds = new Set(Object.entries(attempts)
      .filter(([, attempt]) => attempt.status === "consumed")
      .map(([creditId]) => creditId));
    const due = selectDueCredit(credits, consumedIds, now());

    if (!due) {
      await storeInventorySummary(store, credits, now(), "No full reset is due");
      return;
    }

    const consumed = await consumeAndRefresh(store, credential, due, now, uuid, whamOptions);
    await storeInventorySummary(
      store,
      consumed.credits,
      now(),
      consumed.resultCode ? `Used full reset (${consumed.resultCode})` : "Used full reset",
    );
  } catch (error) {
    await store.put<SafeSummary>(SUMMARY_KEY, {
      configured: true,
      lastCheckAt: iso(now()),
      lastResult: `${safeOperationalError(error)}; it will retry`,
    });
    throw new Error("Scheduled reset check failed");
  }
}

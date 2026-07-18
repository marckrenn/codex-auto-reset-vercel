import {
  AUTH_BASE_URL,
  CODEX_CLIENT_ID,
  DEVICE_FLOW_TTL_MS,
  DEVICE_REDIRECT_URI,
  OAUTH_REFRESH_SKEW_MS,
} from "./config";
import { fetchJson, requireSuccess, type FetchLike, type JsonResponse } from "./http";

const ACCOUNT_CLAIM = "https://api.openai.com/auth";

export type OAuthCredential = {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  accountId: string;
};

export type DeviceFlow = {
  deviceAuthId: string;
  userCode: string;
  intervalMs: number;
  nextPollAt: number;
  expiresAt: number;
};

export type DevicePollResult =
  | { status: "pending"; flow: DeviceFlow }
  | { status: "approved"; credential: OAuthCredential };

export type OAuthOptions = {
  fetch?: FetchLike;
  timeoutMs?: number;
  now?: () => number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseInterval(value: unknown): number | undefined {
  const parsed = typeof value === "string" ? Number(value.trim()) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return undefined;
    const normalized = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder().decode(bytes));
    return isRecord(payload) ? payload : undefined;
  } catch {
    return undefined;
  }
}

export function accountIdFromAccessToken(accessToken: string): string {
  const payload = decodeJwtPayload(accessToken);
  const auth = payload?.[ACCOUNT_CLAIM];
  if (!isRecord(auth) || typeof auth.chatgpt_account_id !== "string" || auth.chatgpt_account_id === "") {
    throw new Error("OAuth token has no ChatGPT account ID");
  }
  return auth.chatgpt_account_id;
}

function credentialFromTokenPayload(value: unknown, nowMs: number, preservedAccountId?: string): OAuthCredential {
  if (!isRecord(value)
    || typeof value.access_token !== "string" || value.access_token === ""
    || typeof value.refresh_token !== "string" || value.refresh_token === ""
    || typeof value.expires_in !== "number" || !Number.isFinite(value.expires_in) || value.expires_in <= 0) {
    throw new Error("OAuth token response is incomplete");
  }

  const expires = nowMs + value.expires_in * 1000;
  if (!Number.isSafeInteger(expires)) throw new Error("OAuth token response is incomplete");
  return {
    type: "oauth",
    access: value.access_token,
    refresh: value.refresh_token,
    expires,
    accountId: preservedAccountId ?? accountIdFromAccessToken(value.access_token),
  };
}

export async function startDeviceFlow(options: OAuthOptions = {}): Promise<DeviceFlow> {
  const nowMs = (options.now ?? Date.now)();
  const response = await fetchJson("OAuth device start", `${AUTH_BASE_URL}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
  }, options);
  const value = requireSuccess("OAuth device start", response);
  const intervalSeconds = isRecord(value) ? parseInterval(value.interval) : undefined;
  if (!isRecord(value)
    || typeof value.device_auth_id !== "string" || value.device_auth_id === ""
    || typeof value.user_code !== "string" || value.user_code === ""
    || intervalSeconds === undefined) {
    throw new Error("OAuth device start response is incomplete");
  }

  return {
    deviceAuthId: value.device_auth_id,
    userCode: value.user_code,
    intervalMs: Math.max(1_000, intervalSeconds * 1000),
    nextPollAt: nowMs,
    expiresAt: nowMs + DEVICE_FLOW_TTL_MS,
  };
}

function pendingDeviceResponse(response: JsonResponse): boolean {
  if (response.status === 403 || response.status === 404) return true;
  if (!isRecord(response.value)) return false;
  const error = response.value.error;
  const code = isRecord(error) ? error.code : error;
  return code === "deviceauth_authorization_pending" || code === "slow_down";
}

async function exchangeDeviceCode(
  authorizationCode: string,
  codeVerifier: string,
  options: OAuthOptions,
): Promise<OAuthCredential> {
  const nowMs = (options.now ?? Date.now)();
  const response = await fetchJson("OAuth token exchange", `${AUTH_BASE_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CODEX_CLIENT_ID,
      code: authorizationCode,
      code_verifier: codeVerifier,
      redirect_uri: DEVICE_REDIRECT_URI,
    }),
  }, options);
  return credentialFromTokenPayload(requireSuccess("OAuth token exchange", response), nowMs);
}

export async function pollDeviceFlow(flow: DeviceFlow, options: OAuthOptions = {}): Promise<DevicePollResult> {
  const nowMs = (options.now ?? Date.now)();
  if (nowMs >= flow.expiresAt) throw new Error("OAuth device flow expired");
  if (nowMs < flow.nextPollAt) return { status: "pending", flow };

  const response = await fetchJson("OAuth device poll", `${AUTH_BASE_URL}/api/accounts/deviceauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_auth_id: flow.deviceAuthId, user_code: flow.userCode }),
  }, options);

  if (!response.ok && pendingDeviceResponse(response)) {
    const slowDown = isRecord(response.value)
      && (isRecord(response.value.error) ? response.value.error.code : response.value.error) === "slow_down";
    const intervalMs = flow.intervalMs + (slowDown ? 5_000 : 0);
    return { status: "pending", flow: { ...flow, intervalMs, nextPollAt: nowMs + intervalMs } };
  }

  const value = requireSuccess("OAuth device poll", response);
  if (!isRecord(value)
    || typeof value.authorization_code !== "string" || value.authorization_code === ""
    || typeof value.code_verifier !== "string" || value.code_verifier === "") {
    throw new Error("OAuth device poll response is incomplete");
  }

  return {
    status: "approved",
    credential: await exchangeDeviceCode(value.authorization_code, value.code_verifier, options),
  };
}

export function oauthNeedsRefresh(credential: OAuthCredential, nowMs = Date.now()): boolean {
  return credential.expires <= nowMs + OAUTH_REFRESH_SKEW_MS;
}

export async function refreshOAuthCredential(
  credential: OAuthCredential,
  options: OAuthOptions = {},
): Promise<OAuthCredential> {
  const nowMs = (options.now ?? Date.now)();
  const response = await fetchJson("OAuth refresh", `${AUTH_BASE_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: credential.refresh,
      client_id: CODEX_CLIENT_ID,
    }),
  }, options);
  return credentialFromTokenPayload(requireSuccess("OAuth refresh", response), nowMs, credential.accountId);
}

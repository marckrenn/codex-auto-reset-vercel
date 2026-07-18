import { WHAM_BASE_URL } from "./config";
import { fetchJson, requireSuccess, type FetchLike } from "./http";
import type { OAuthCredential } from "./oauth";
import { parseResetCredits, type ResetCredit } from "./schedule";

export type WhamOptions = {
  fetch?: FetchLike;
  timeoutMs?: number;
  now?: () => number;
};

export type ConsumeResult = {
  code?: string;
  windowsReset?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function headersFor(credential: OAuthCredential, jsonBody = false): Record<string, string> {
  return {
    Authorization: `Bearer ${credential.access}`,
    Accept: "application/json",
    originator: "pi",
    "ChatGPT-Account-Id": credential.accountId,
    ...(jsonBody ? { "Content-Type": "application/json" } : {}),
  };
}

export async function getResetCredits(
  credential: OAuthCredential,
  options: WhamOptions = {},
): Promise<ResetCredit[]> {
  const response = await fetchJson("WHAM credits", `${WHAM_BASE_URL}/rate-limit-reset-credits`, {
    method: "GET",
    headers: headersFor(credential),
  }, options);
  return parseResetCredits(requireSuccess("WHAM credits", response));
}

export async function consumeResetCredit(
  credential: OAuthCredential,
  creditId: string,
  redeemRequestId: string,
  expiresMs: number,
  options: WhamOptions = {},
): Promise<ConsumeResult> {
  if (creditId === "" || redeemRequestId === "") throw new Error("Credit ID and redemption ID are required");
  if ((options.now ?? Date.now)() >= expiresMs) throw new Error("Reset credit expired");

  const response = await fetchJson("WHAM consume", `${WHAM_BASE_URL}/rate-limit-reset-credits/consume`, {
    method: "POST",
    headers: headersFor(credential, true),
    body: JSON.stringify({ credit_id: creditId, redeem_request_id: redeemRequestId }),
  }, options);
  const value = requireSuccess("WHAM consume", response);
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error("WHAM consume response is invalid");

  return {
    ...(typeof value.code === "string" ? { code: value.code } : {}),
    ...(typeof value.windows_reset === "number" && Number.isFinite(value.windows_reset)
      ? { windowsReset: value.windows_reset }
      : {}),
  };
}

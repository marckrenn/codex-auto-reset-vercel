export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const AUTH_BASE_URL = "https://auth.openai.com";
export const WHAM_BASE_URL = "https://chatgpt.com/backend-api/wham";
export const DEVICE_VERIFICATION_URL = `${AUTH_BASE_URL}/codex/device`;
export const DEVICE_REDIRECT_URI = `${AUTH_BASE_URL}/deviceauth/callback`;

export const LEAD_TIME_MS = 10 * 60 * 1000;
export const OAUTH_REFRESH_SKEW_MS = 60 * 1000;
export const REQUEST_TIMEOUT_MS = 15 * 1000;
export const DEVICE_FLOW_TTL_MS = 15 * 60 * 1000;
export const MAX_RESPONSE_BYTES = 1_000_000;

export function assertMasterKey(masterKey: string): void {
  if (typeof masterKey !== "string" || masterKey.length < 32) {
    throw new Error("MASTER_KEY must contain at least 32 characters");
  }
}

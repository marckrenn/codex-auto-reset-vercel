import { describe, expect, test } from "bun:test";
import {
  pollDeviceFlow,
  refreshOAuthCredential,
  startDeviceFlow,
  type OAuthCredential,
} from "../src/oauth";

function accessToken(accountId = "account-1"): string {
  const encode = (value: unknown) => btoa(JSON.stringify(value)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${encode({ alg: "none" })}.${encode({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })}.signature`;
}

describe("Codex device OAuth", () => {
  test("moves from device start through pending to approved credentials", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    let pollCount = 0;
    const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/deviceauth/usercode")) {
        return Response.json({ device_auth_id: "device-secret", user_code: "ABCD-EFGH", interval: 1 });
      }
      if (url.endsWith("/deviceauth/token")) {
        pollCount += 1;
        return pollCount === 1
          ? Response.json({ error: "deviceauth_authorization_pending" }, { status: 403 })
          : Response.json({ authorization_code: "authorization-code", code_verifier: "pkce-verifier" });
      }
      return Response.json({
        access_token: accessToken(),
        refresh_token: "refresh-1",
        expires_in: 3600,
      });
    };

    const flow = await startDeviceFlow({ fetch, now: () => 1_000 });
    const pending = await pollDeviceFlow(flow, { fetch, now: () => 1_000 });
    expect(pending.status).toBe("pending");
    if (pending.status !== "pending") throw new Error("expected pending");

    const approved = await pollDeviceFlow(pending.flow, { fetch, now: () => 2_000 });
    expect(approved.status).toBe("approved");
    if (approved.status !== "approved") throw new Error("expected approval");
    expect(approved.credential).toEqual({
      type: "oauth",
      access: accessToken(),
      refresh: "refresh-1",
      expires: 3_602_000,
      accountId: "account-1",
    });

    expect(requests.map(({ url }) => url)).toEqual([
      "https://auth.openai.com/api/accounts/deviceauth/usercode",
      "https://auth.openai.com/api/accounts/deviceauth/token",
      "https://auth.openai.com/api/accounts/deviceauth/token",
      "https://auth.openai.com/oauth/token",
    ]);
    expect(String(requests[3]?.init?.body)).toContain("redirect_uri=https%3A%2F%2Fauth.openai.com%2Fdeviceauth%2Fcallback");
  });

  test("refresh requires and returns a rotated refresh token", async () => {
    const credential: OAuthCredential = {
      type: "oauth",
      access: accessToken(),
      refresh: "old-refresh",
      expires: 0,
      accountId: "account-1",
    };
    let body = "";
    const refreshed = await refreshOAuthCredential(credential, {
      now: () => 5_000,
      fetch: async (_input, init) => {
        body = String(init?.body);
        return Response.json({ access_token: accessToken(), refresh_token: "new-refresh", expires_in: 60 });
      },
    });

    expect(body).toContain("refresh_token=old-refresh");
    expect(refreshed.refresh).toBe("new-refresh");
    expect(refreshed.expires).toBe(65_000);
    expect(refreshed.accountId).toBe("account-1");
  });
});

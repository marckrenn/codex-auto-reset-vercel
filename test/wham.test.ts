import { describe, expect, test } from "bun:test";
import type { OAuthCredential } from "../src/oauth";
import { consumeResetCredit, getResetCredits } from "../src/wham";

const credential: OAuthCredential = {
  type: "oauth",
  access: "access-secret",
  refresh: "refresh-secret",
  expires: Date.now() + 60_000,
  accountId: "account-1",
};

describe("WHAM client", () => {
  test("uses exact inventory and consume requests without exposing auth in results", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      requests.push({ url, init });
      return url.endsWith("/consume")
        ? Response.json({ code: "reset", windows_reset: 2 })
        : Response.json({ credits: [{ id: "credit-1", status: "available", expires_at: "2026-07-18T12:05:00Z" }] });
    };

    const credits = await getResetCredits(credential, { fetch });
    const result = await consumeResetCredit(credential, "credit-1", "uuid-1", Date.now() + 60_000, { fetch });

    expect(credits[0]?.id).toBe("credit-1");
    expect(result).toEqual({ code: "reset", windowsReset: 2 });
    expect(requests.map(({ url }) => url)).toEqual([
      "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
      "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume",
    ]);
    expect(requests[0]?.init?.headers).toEqual({
      Authorization: "Bearer access-secret",
      Accept: "application/json",
      originator: "pi",
      "ChatGPT-Account-Id": "account-1",
    });
    expect(requests[1]?.init?.body).toBe(JSON.stringify({ credit_id: "credit-1", redeem_request_id: "uuid-1" }));
  });

  test("refuses an expired credit before fetch", async () => {
    let called = false;
    await expect(consumeResetCredit(credential, "credit-1", "uuid-1", 10, {
      now: () => 10,
      fetch: async () => {
        called = true;
        return Response.json({});
      },
    })).rejects.toThrow("expired");
    expect(called).toBeFalse();
  });
});

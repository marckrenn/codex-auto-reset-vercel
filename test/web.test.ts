import { describe, expect, test } from "bun:test";
import { hasSameOrigin, isAuthenticated } from "../src/web";

function request(headers: Record<string, string> = {}) {
  return { headers, cookies: {} } as never;
}

describe("web security", () => {
  test("requires exact Basic credentials", () => {
    const key = "a-secure-master-key-that-is-long-enough";
    const valid = `Basic ${Buffer.from(`admin:${key}`).toString("base64")}`;
    expect(isAuthenticated(request({ authorization: valid }), key)).toBeTrue();
    expect(isAuthenticated(request({ authorization: valid }), "another-secure-master-key-long-enough")).toBeFalse();
  });

  test("accepts matching origins and rejects foreign requests", () => {
    expect(hasSameOrigin(request({ origin: "https://reset.vercel.app", "x-forwarded-proto": "https", "x-forwarded-host": "reset.vercel.app", "sec-fetch-site": "same-site" }))).toBeTrue();
    expect(hasSameOrigin(request({ origin: "https://attacker.example", "x-forwarded-proto": "https", "x-forwarded-host": "reset.vercel.app" }))).toBeFalse();
    expect(hasSameOrigin(request({ "sec-fetch-site": "cross-site" }))).toBeFalse();
  });
});

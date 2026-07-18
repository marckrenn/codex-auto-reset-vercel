import { describe, expect, test } from "bun:test";
import { hasSameOrigin, isAuthenticated } from "../api/_shared";

function request(headers: Record<string, string> = {}) {
  return { headers, cookies: {} } as never;
}

describe("probe security", () => {
  test("requires exact Basic credentials", () => {
    const valid = `Basic ${Buffer.from("admin:a-secure-master-key-that-is-long-enough").toString("base64")}`;
    expect(isAuthenticated(request({ authorization: valid }), "a-secure-master-key-that-is-long-enough")).toBeTrue();
    expect(isAuthenticated(request({ authorization: valid }), "another-secure-master-key-long-enough")).toBeFalse();
  });

  test("accepts matching origins and rejects foreign ones", () => {
    expect(hasSameOrigin(request({ origin: "https://probe.vercel.app", "x-forwarded-proto": "https", "x-forwarded-host": "probe.vercel.app", "sec-fetch-site": "same-site" }))).toBeTrue();
    expect(hasSameOrigin(request({ origin: "https://attacker.example", "x-forwarded-proto": "https", "x-forwarded-host": "probe.vercel.app" }))).toBeFalse();
    expect(hasSameOrigin(request({ "sec-fetch-site": "cross-site" }))).toBeFalse();
  });
});

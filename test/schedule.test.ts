import { describe, expect, test } from "bun:test";
import { earliestAvailableExpiry, parseResetCredits, selectDueCredit } from "../src/schedule";

const now = Date.parse("2026-07-18T12:00:00Z");

function credit(id: string, expiresAt: string, status = "available") {
  return { id, status, expires_at: expiresAt };
}

describe("reset-credit scheduling", () => {
  test("selects the earliest available credit only in its final ten minutes", () => {
    const credits = [
      credit("later", "2026-07-18T12:09:00Z"),
      credit("first", "2026-07-18T12:05:00Z"),
      credit("future", "2026-07-18T12:11:00Z"),
    ];

    expect(selectDueCredit(credits, new Set(), now)?.id).toBe("first");
    expect(selectDueCredit(credits, new Set(["first"]), now)?.id).toBe("later");
    expect(earliestAvailableExpiry(credits, now)).toBe("2026-07-18T12:05:00Z");
  });

  test("ignores malformed, unavailable, consumed, and expired rows", () => {
    const credits = parseResetCredits({ credits: [
      { id: "", status: "available", expires_at: "2026-07-18T12:05:00Z" },
      { id: "bad", status: "available", expires_at: "nope" },
      credit("expired", "2026-07-18T12:00:00Z"),
      credit("used", "2026-07-18T12:05:00Z", "consumed"),
      credit("ok", "2026-07-18T12:05:00Z"),
    ] });

    expect(selectDueCredit(credits, new Set(), now)?.id).toBe("ok");
    expect(() => parseResetCredits({})).toThrow("credits array");
  });
});

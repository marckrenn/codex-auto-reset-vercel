import { describe, expect, test } from "bun:test";
import { checkCronExpression, checkIntervalMinutes, redeemLeadTimeMs } from "../src/config";

describe("environment settings", () => {
  test("uses safe defaults", () => {
    expect(checkIntervalMinutes({})).toBe(5);
    expect(checkCronExpression({})).toBe("*/5 * * * *");
    expect(redeemLeadTimeMs({})).toBe(10 * 60 * 1000);
  });

  test("accepts bounded integer overrides", () => {
    expect(checkIntervalMinutes({ CHECK_INTERVAL_MINUTES: "15" })).toBe(15);
    expect(checkCronExpression({ CHECK_INTERVAL_MINUTES: "15" })).toBe("*/15 * * * *");
    expect(redeemLeadTimeMs({ REDEEM_LEAD_MINUTES: "7" })).toBe(7 * 60 * 1000);
  });

  test("rejects invalid values", () => {
    expect(() => checkIntervalMinutes({ CHECK_INTERVAL_MINUTES: "0" })).toThrow();
    expect(() => checkIntervalMinutes({ CHECK_INTERVAL_MINUTES: "2.5" })).toThrow();
    expect(() => redeemLeadTimeMs({ REDEEM_LEAD_MINUTES: "61" })).toThrow();
  });
});

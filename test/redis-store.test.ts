import { describe, expect, test } from "bun:test";
import { statePrefix } from "../src/redis-store";

describe("Redis state namespace", () => {
  test("preserves the production prefix when unset", () => {
    expect(statePrefix({})).toBe("codex-auto-reset:v1:");
  });

  test("isolates an explicitly named deployment", () => {
    expect(statePrefix({ STATE_NAMESPACE: "deploy-test" })).toBe("codex-auto-reset:v1:deploy-test:");
  });

  test("rejects unsafe namespace characters", () => {
    expect(() => statePrefix({ STATE_NAMESPACE: "../production" })).toThrow();
    expect(() => statePrefix({ STATE_NAMESPACE: "x".repeat(49) })).toThrow();
  });
});

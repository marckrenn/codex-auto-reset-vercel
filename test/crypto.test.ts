import { describe, expect, test } from "bun:test";
import { constantTimeEqual, decryptJson, encryptJson } from "../src/crypto";
import { assertMasterKey } from "../src/config";

describe("credential encryption", () => {
  test("round-trips with the right key and fails closed with another key", async () => {
    const key = "a".repeat(32);
    const encrypted = await encryptJson({ access: "secret", expires: 123 }, key);

    expect(encrypted.ciphertext).not.toContain("secret");
    expect(await decryptJson<{ access: string; expires: number }>(encrypted, key)).toEqual({ access: "secret", expires: 123 });
    await expect(decryptJson(encrypted, "b".repeat(32))).rejects.toThrow("Unable to decrypt");
  });

  test("validates and compares master keys", () => {
    expect(() => assertMasterKey("short")).toThrow("at least 32");
    expect(() => assertMasterKey("x".repeat(32))).not.toThrow();
    expect(constantTimeEqual("same", "same")).toBeTrue();
    expect(constantTimeEqual("same", "different")).toBeFalse();
  });
});

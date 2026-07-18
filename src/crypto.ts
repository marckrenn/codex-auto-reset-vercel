const encoder = new TextEncoder();
const decoder = new TextDecoder();
const KEY_CONTEXT = "codex-auto-reset-vercel:credential:v1:";

export type EncryptedValue = {
  version: 1;
  iv: string;
  ciphertext: string;
};

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function deriveKey(masterKey: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`${KEY_CONTEXT}${masterKey}`));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptJson(value: unknown, masterKey: string): Promise<EncryptedValue> {
  const key = await deriveKey(masterKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return { version: 1, iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(ciphertext)) };
}

export async function decryptJson<T>(value: EncryptedValue, masterKey: string): Promise<T> {
  if (value?.version !== 1 || typeof value.iv !== "string" || typeof value.ciphertext !== "string") {
    throw new Error("Invalid encrypted credential");
  }

  try {
    const key = await deriveKey(masterKey);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(value.iv) },
      key,
      fromBase64(value.ciphertext),
    );
    return JSON.parse(decoder.decode(plaintext)) as T;
  } catch {
    throw new Error("Unable to decrypt credential");
  }
}

export function constantTimeEqual(left: string, right: string): boolean {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const length = Math.max(a.length, b.length);
  let difference = a.length ^ b.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

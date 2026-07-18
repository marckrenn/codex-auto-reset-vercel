import type { VercelRequest, VercelResponse } from "@vercel/node";
import { assertMasterKey, DEVICE_VERIFICATION_URL } from "../src/config";
import { constantTimeEqual, decryptJson, encryptJson, type EncryptedValue } from "../src/crypto";
import { RemoteRequestError } from "../src/http";
import type { DeviceFlow } from "../src/oauth";

const FLOW_COOKIE = "codex_probe_flow";

export function masterKey(): string {
  const value = process.env.MASTER_KEY ?? "";
  assertMasterKey(value);
  return value;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function isAuthenticated(request: VercelRequest, key: string): boolean {
  const authorization = headerValue(request.headers.authorization);
  if (!authorization?.startsWith("Basic ")) return false;
  try {
    const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    return separator >= 0
      && constantTimeEqual(decoded.slice(0, separator), "admin")
      && constantTimeEqual(decoded.slice(separator + 1), key);
  } catch {
    return false;
  }
}

export function hasSameOrigin(request: VercelRequest): boolean {
  const origin = headerValue(request.headers.origin);
  if (origin !== undefined && origin !== "null") {
    const proto = headerValue(request.headers["x-forwarded-proto"]) ?? "https";
    const host = headerValue(request.headers["x-forwarded-host"])
      ?? headerValue(request.headers.host);
    if (!host) return false;
    try {
      return new URL(origin).origin === `${proto}://${host}`;
    } catch {
      return false;
    }
  }

  const fetchSite = headerValue(request.headers["sec-fetch-site"]);
  return fetchSite === undefined || fetchSite === "same-origin" || fetchSite === "none";
}

export function setSecurityHeaders(response: VercelResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

export function requirePageAuth(request: VercelRequest, response: VercelResponse): string | undefined {
  let key: string;
  try {
    key = masterKey();
  } catch {
    setSecurityHeaders(response);
    response.status(500).send("Server configuration is invalid");
    return undefined;
  }
  if (!isAuthenticated(request, key)) {
    setSecurityHeaders(response);
    response.setHeader("WWW-Authenticate", 'Basic realm="Codex Vercel Probe", charset="UTF-8"');
    response.status(401).send("Authentication required");
    return undefined;
  }
  return key;
}

export function requireMutation(request: VercelRequest, response: VercelResponse): string | undefined {
  const key = requirePageAuth(request, response);
  if (!key) return undefined;
  if (request.method !== "POST") {
    setSecurityHeaders(response);
    response.setHeader("Allow", "POST");
    response.status(405).send("Method not allowed");
    return undefined;
  }
  if (!hasSameOrigin(request)) {
    setSecurityHeaders(response);
    response.status(403).send("Cross-origin request rejected");
    return undefined;
  }
  return key;
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function page(content: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Codex Vercel Probe</title><style>body{font:16px/1.45 system-ui;background:#111;color:#f5f5f5;margin:0;padding:32px}main{max-width:650px;margin:auto;border:1px solid #444;border-radius:14px;padding:26px}button,a.button{display:inline-block;background:#e32b22;color:white;border:0;border-radius:8px;padding:11px 16px;text-decoration:none;font:inherit;font-weight:600}code{font-size:1.35em;background:#292929;padding:5px 9px;border-radius:6px}.muted{color:#aaa}.ok{color:#65d885}.bad{color:#ff756d}dt{font-weight:700;margin-top:14px}dd{margin:3px 0}</style></head><body><main><h1>Vercel compatibility probe</h1>${content}</main></body></html>`;
}

export function sendPage(response: VercelResponse, content: string, status = 200): void {
  setSecurityHeaders(response);
  response.status(status).setHeader("Content-Type", "text/html; charset=utf-8").send(page(content));
}

export function startContent(): string {
  return `<p>This private probe performs device login and one read-only reset-credit inventory request. It never consumes a credit.</p><form method="post" action="/api/start"><button type="submit">Start compatibility test</button></form>`;
}

export function deviceContent(flow: DeviceFlow, message = "Waiting for approval"): string {
  return `<p>${escapeHtml(message)}.</p><p><a class="button" href="${DEVICE_VERIFICATION_URL}" target="_blank" rel="noopener noreferrer">Open OpenAI device login</a></p><p>Enter code: <code>${escapeHtml(flow.userCode)}</code></p><form method="post" action="/api/poll"><button type="submit">I approved it — test Vercel</button></form><p class="muted">The encrypted test cookie expires after 15 minutes.</p>`;
}

export function resultContent(result: { ok: boolean; message: string; availableCount?: number; nextExpiry?: string }): string {
  return `<p class="${result.ok ? "ok" : "bad"}"><strong>${result.ok ? "Compatible" : "Blocked"}</strong></p><dl><dt>Result</dt><dd>${escapeHtml(result.message)}</dd><dt>Available credits</dt><dd>${escapeHtml(result.availableCount ?? "—")}</dd><dt>Next expiry</dt><dd>${escapeHtml(result.nextExpiry ?? "—")}</dd></dl><p class="muted">No credit was consumed and the OAuth credential was not persisted.</p>`;
}

export function safeError(error: unknown): string {
  if (error instanceof RemoteRequestError) return error.message;
  if (error instanceof Error && /^(OAuth|Stored OAuth|Unable to decrypt|Invalid encrypted)/.test(error.message)) {
    return error.message;
  }
  return "Compatibility test failed";
}

export async function encodeFlow(flow: DeviceFlow, key: string): Promise<string> {
  const encrypted = await encryptJson(flow, key);
  return Buffer.from(JSON.stringify(encrypted)).toString("base64url");
}

export async function decodeFlow(request: VercelRequest, key: string): Promise<DeviceFlow> {
  const encoded = request.cookies[FLOW_COOKIE];
  if (!encoded) throw new Error("OAuth device flow is missing");
  const encrypted = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as EncryptedValue;
  return decryptJson<DeviceFlow>(encrypted, key);
}

export function setFlowCookie(response: VercelResponse, value: string): void {
  response.setHeader("Set-Cookie", `${FLOW_COOKIE}=${value}; Path=/api; Max-Age=900; HttpOnly; Secure; SameSite=Strict`);
}

export function clearFlowCookie(response: VercelResponse): void {
  response.setHeader("Set-Cookie", `${FLOW_COOKIE}=; Path=/api; Max-Age=0; HttpOnly; Secure; SameSite=Strict`);
}

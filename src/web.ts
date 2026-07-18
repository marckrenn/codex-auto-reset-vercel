import type { VercelRequest, VercelResponse } from "@vercel/node";
import { assertMasterKey } from "./config";
import { constantTimeEqual } from "./crypto";
import { RedisStateStore, redisClient, withOperationLock } from "./redis-store";
import type { ServiceView, StateStore } from "./service";

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function masterKey(): string {
  const value = process.env.MASTER_KEY ?? "";
  assertMasterKey(value);
  return value;
}

export function requestOrigin(request: VercelRequest): string {
  const proto = headerValue(request.headers["x-forwarded-proto"]) ?? "https";
  const host = headerValue(request.headers["x-forwarded-host"]) ?? headerValue(request.headers.host);
  if (!host) throw new Error("Request host is missing");
  return `${proto}://${host}`;
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
    try {
      return new URL(origin).origin === requestOrigin(request);
    } catch {
      return false;
    }
  }
  const fetchSite = headerValue(request.headers["sec-fetch-site"]);
  return fetchSite === undefined || fetchSite === "same-origin" || fetchSite === "none";
}

export function setSecurityHeaders(response: VercelResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Security-Policy", "default-src 'self'; connect-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
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
    response.status(503).send("Application configuration is invalid");
    return undefined;
  }
  if (!isAuthenticated(request, key)) {
    setSecurityHeaders(response);
    response.setHeader("WWW-Authenticate", 'Basic realm="Codex Auto Reset", charset="UTF-8"');
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

export async function withStore<T>(work: (store: StateStore) => Promise<T>): Promise<T> {
  const redis = redisClient();
  return withOperationLock(redis, () => work(new RedisStateStore(redis)));
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatDate(value?: string | number): string {
  if (value === undefined) return "—";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "—";
}

function page(content: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Codex Auto Reset</title><style>:root{color-scheme:light dark;font-family:system-ui,sans-serif}body{max-width:42rem;margin:4rem auto;padding:0 1rem;line-height:1.5}main{border:1px solid #8886;border-radius:12px;padding:1.5rem}code{font-size:1.35rem;letter-spacing:.08em;user-select:all}button,a.button{display:inline-block;border:0;border-radius:8px;padding:.7rem 1rem;background:#1677ff;color:white;text-decoration:none;cursor:pointer}button.danger{background:#b42318}dt{font-weight:600;margin-top:.8rem}dd{margin-left:0;overflow-wrap:anywhere}.muted{opacity:.72}</style></head><body><main><h1>Codex Auto Reset</h1>${content}</main></body></html>`;
}

export function sendPage(response: VercelResponse, content: string, status = 200): void {
  setSecurityHeaders(response);
  response.status(status).setHeader("Content-Type", "text/html; charset=utf-8").send(page(content));
}

export function sendJson(response: VercelResponse, value: unknown, status = 200): void {
  setSecurityHeaders(response);
  response.status(status).json(value);
}

export function redirect(response: VercelResponse, path = "/"): void {
  setSecurityHeaders(response);
  response.status(303).setHeader("Location", path).send("");
}

export function renderRecovery(response: VercelResponse): void {
  sendPage(response, `<p><strong>The stored credential cannot be decrypted with the current MASTER_KEY.</strong></p><p>Reset the encrypted state, then perform Codex login again.</p><form method="post" action="/reset" onsubmit="return confirm('Permanently remove the unreadable OAuth credential and redemption state?')"><input type="hidden" name="confirm" value="reset"><button class="danger" type="submit">Reset unreadable state</button></form>`, 409);
}

export function renderService(response: VercelResponse, view: ServiceView): void {
  if (view.configured) {
    const summary = view.summary;
    sendPage(response, `<p><strong>Configured and active.</strong> QStash checks reset credits every five minutes.</p><dl><dt>Available credits</dt><dd>${summary.availableCount ?? "—"}</dd><dt>Next expiry</dt><dd>${escapeHtml(formatDate(summary.nextExpiry))}</dd><dt>Last check</dt><dd>${escapeHtml(formatDate(summary.lastCheckAt))}</dd><dt>Last result</dt><dd>${escapeHtml(summary.lastResult ?? "Waiting for the first scheduled check")}</dd></dl><form method="post" action="/check"><button type="submit">Check now</button></form><p></p><form method="post" action="/reset" onsubmit="return confirm('Remove the stored OAuth credential, schedule, and redemption state?')"><input type="hidden" name="confirm" value="reset"><button class="danger" type="submit">Reset OAuth setup</button></form>`);
    return;
  }

  if (view.deviceFlow) {
    const flow = view.deviceFlow;
    const retryMs = Math.max(1_000, flow.nextPollAt - Date.now());
    sendPage(response, `<p>Open the official OpenAI page and enter this device code:</p><p><a class="button" href="https://auth.openai.com/codex/device" target="_blank" rel="noopener noreferrer">Open OpenAI device login</a></p><p><code>${escapeHtml(flow.userCode)}</code></p><p class="muted">This code expires at ${escapeHtml(formatDate(flow.expiresAt))}. This page checks approval automatically.</p><p id="status">Waiting for approval…</p><script>const status=document.getElementById('status');async function check(){try{const response=await fetch('/setup/status',{method:'POST',credentials:'same-origin'});const result=await response.json();if(result.status==='configured'){location.reload();return}status.textContent=result.message||'Waiting for approval…';setTimeout(check,Math.max(1000,result.retryAfterMs||${flow.intervalMs}))}catch{status.textContent='Status check failed; retrying…';setTimeout(check,5000)}}setTimeout(check,${retryMs});</script>`);
    return;
  }

  sendPage(response, `<p>No Codex account is connected yet.</p><p>Authentication happens directly on OpenAI's website; this app never sees your password.</p><form method="post" action="/setup/start"><button type="submit">Start Codex login</button></form>`);
}

export async function readSmallForm(request: VercelRequest): Promise<URLSearchParams> {
  const body = typeof request.body === "string"
    ? request.body
    : request.body instanceof Buffer
      ? request.body.toString("utf8")
      : new URLSearchParams(request.body as Record<string, string>).toString();
  if (Buffer.byteLength(body) > 1_024) throw new Error("Request too large");
  return new URLSearchParams(body);
}

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { assertMasterKey, checkIntervalMinutes, redeemLeadTimeMs } from "./config";
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

function timeMarkup(value?: string | number, relative = false): string {
  const iso = formatDate(value);
  if (iso === "—") return iso;
  return `<time datetime="${escapeHtml(iso)}" data-local${relative ? " data-relative" : ""}>${escapeHtml(iso)}</time>`;
}

function page(content: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>Codex Auto Reset</title>
  <style>
    :root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#f5f5f5;background:#090909;font-synthesis:none}
    *{box-sizing:border-box}
    body{min-height:100vh;margin:0;padding:48px 20px;background:radial-gradient(circle at 50% -20%,#1c2430 0,transparent 36%),#090909;line-height:1.45}
    main{width:min(760px,100%);margin:0 auto;background:#111;border:1px solid #303030;border-radius:20px;padding:32px;box-shadow:0 24px 80px #0007}
    h1{margin:0;font-size:clamp(1.8rem,5vw,2.35rem);letter-spacing:-.04em}
    p{margin:0}
    .header{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:30px}
    .status{display:inline-flex;align-items:center;gap:8px;padding:7px 10px;border:1px solid #285b3c;border-radius:999px;background:#12291b;color:#82e9a6;font-size:.82rem;font-weight:700;white-space:nowrap}
    .status-dot{width:8px;height:8px;border-radius:50%;background:#45d477;box-shadow:0 0 0 4px #45d47720}
    .intro{color:#b6b6b6;margin:-14px 0 24px}
    .metrics{display:grid;grid-template-columns:.7fr 1.3fr 1.3fr;gap:12px;margin:0 0 16px}
    .metric{min-width:0;padding:18px;background:#171717;border:1px solid #2b2b2b;border-radius:14px}
    .label{display:block;margin-bottom:9px;color:#969696;font-size:.75rem;font-weight:750;letter-spacing:.07em;text-transform:uppercase}
    .value{display:block;color:#fafafa;font-size:1rem;font-weight:650;overflow-wrap:anywhere}
    .value.large{font-size:2rem;line-height:1}
    .hint{display:block;margin-top:5px;color:#777;font-size:.78rem}
    .result{margin:0 0 18px;padding:17px 18px;border:1px solid #2b2b2b;border-radius:14px;background:#141414}
    .result p{font-weight:600;overflow-wrap:anywhere}
    .settings{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 24px}
    .chip{padding:6px 9px;border-radius:7px;background:#1a1a1a;border:1px solid #2c2c2c;color:#a7a7a7;font-size:.78rem}
    .actions{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-top:22px;border-top:1px solid #292929}
    .actions form{margin:0}
    button,a.button{appearance:none;display:inline-flex;align-items:center;justify-content:center;min-height:42px;border:1px solid transparent;border-radius:9px;padding:0 15px;background:#2780ff;color:white;text-decoration:none;font:inherit;font-size:.9rem;font-weight:700;cursor:pointer;transition:filter .15s,border-color .15s,background .15s}
    button:hover,a.button:hover{filter:brightness(1.1)}
    button.danger{border-color:#5f2525;background:transparent;color:#f28c8c}
    code{display:inline-block;padding:8px 11px;border:1px solid #343434;border-radius:9px;background:#191919;font-size:1.35rem;letter-spacing:.08em;user-select:all}
    .muted{color:#8d8d8d}
    .setup{display:grid;gap:18px}
    footer{margin-top:22px;color:#666;font-size:.75rem;text-align:center}
    @media(max-width:640px){body{padding:18px 12px}main{padding:22px;border-radius:16px}.header{align-items:flex-start;flex-direction:column}.metrics{grid-template-columns:1fr}.actions{align-items:stretch;flex-direction:column}.actions form,.actions button{width:100%}}
  </style>
</head>
<body>
  <main>${content}<footer>Unofficial, user-owned deployment</footer></main>
  <script>
    const rtf=new Intl.RelativeTimeFormat(undefined,{numeric:'auto'});
    function relative(date){const seconds=(date-Date.now())/1000;const abs=Math.abs(seconds);if(abs>=86400)return rtf.format(Math.round(seconds/86400),'day');if(abs>=3600)return rtf.format(Math.round(seconds/3600),'hour');if(abs>=60)return rtf.format(Math.round(seconds/60),'minute');return rtf.format(Math.round(seconds),'second')}
    document.querySelectorAll('time[data-local]').forEach((element)=>{const date=new Date(element.dateTime);if(!Number.isFinite(date.getTime()))return;element.title=date.toISOString();element.textContent=new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'}).format(date);if(element.hasAttribute('data-relative')){const hint=element.parentElement?.querySelector('.hint');if(hint)hint.textContent=relative(date)}});
  </script>
</body>
</html>`;
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
  sendPage(response, `<div class="header"><h1>Codex Auto Reset</h1></div><div class="setup"><p><strong>The stored credential cannot be decrypted with the current MASTER_KEY.</strong></p><p class="muted">Reset the encrypted state, then perform Codex login again.</p><form method="post" action="/reset" onsubmit="return confirm('Permanently remove the unreadable OAuth credential and redemption state?')"><input type="hidden" name="confirm" value="reset"><button class="danger" type="submit">Reset unreadable state</button></form></div>`, 409);
}

export function renderService(response: VercelResponse, view: ServiceView): void {
  if (view.configured) {
    const summary = view.summary;
    const interval = checkIntervalMinutes();
    const lead = redeemLeadTimeMs() / 60_000;
    sendPage(response, `
<div class="header"><h1>Codex Auto Reset</h1><span class="status"><span class="status-dot"></span>Active</span></div>
<p class="intro">Reset credits are monitored automatically by QStash.</p>
<section class="metrics" aria-label="Reset credit status">
  <div class="metric"><span class="label">Available credits</span><strong class="value large">${summary.availableCount ?? "—"}</strong></div>
  <div class="metric"><span class="label">Next expiry</span><strong class="value">${timeMarkup(summary.nextExpiry, true)}<span class="hint"></span></strong></div>
  <div class="metric"><span class="label">Last check</span><strong class="value">${timeMarkup(summary.lastCheckAt, true)}<span class="hint"></span></strong></div>
</section>
<section class="result"><span class="label">Last result</span><p>${escapeHtml(summary.lastResult ?? "Waiting for the first scheduled check")}</p></section>
<div class="settings" aria-label="Configuration"><span class="chip">Check every ${interval} min</span><span class="chip">Redeem in final ${lead} min</span><span class="chip">Encrypted storage</span></div>
<div class="actions"><form method="post" action="/check"><button type="submit">Check now</button></form><form method="post" action="/reset" onsubmit="return confirm('Remove the stored OAuth credential, schedule, and redemption state?')"><input type="hidden" name="confirm" value="reset"><button class="danger" type="submit">Reset OAuth setup</button></form></div>`);
    return;
  }

  if (view.deviceFlow) {
    const flow = view.deviceFlow;
    const retryMs = Math.max(1_000, flow.nextPollAt - Date.now());
    sendPage(response, `<div class="header"><h1>Connect Codex</h1></div><div class="setup"><p>Open the official OpenAI page and enter this device code:</p><p><a class="button" href="https://auth.openai.com/codex/device" target="_blank" rel="noopener noreferrer">Open OpenAI device login</a></p><p><code>${escapeHtml(flow.userCode)}</code></p><p class="muted">This code expires ${timeMarkup(flow.expiresAt, true)}<span class="hint"></span>. This page checks approval automatically.</p><p id="status">Waiting for approval…</p></div><script>const status=document.getElementById('status');async function check(){try{const response=await fetch('/setup/status',{method:'POST',credentials:'same-origin'});const result=await response.json();if(result.status==='configured'){location.reload();return}status.textContent=result.message||'Waiting for approval…';setTimeout(check,Math.max(1000,result.retryAfterMs||${flow.intervalMs}))}catch{status.textContent='Status check failed; retrying…';setTimeout(check,5000)}}setTimeout(check,${retryMs});</script>`);
    return;
  }

  sendPage(response, `<div class="header"><h1>Codex Auto Reset</h1></div><div class="setup"><p>No Codex account is connected yet.</p><p class="muted">Authentication happens directly on OpenAI's website. This app never sees your password.</p><form method="post" action="/setup/start"><button type="submit">Start Codex login</button></form></div>`);
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

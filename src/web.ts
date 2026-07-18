import type { VercelRequest, VercelResponse } from "./vercel-types";
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
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.status(401).send(page(`<div class="header"><h1>Codex Auto Reset</h1><span class="status"><span class="status-dot"></span>Private</span></div><div class="setup"><p><strong>Deployment ready.</strong></p><p class="muted">This dashboard is protected with your MASTER_KEY.</p><p><a class="button" href="/" target="_blank" rel="noopener noreferrer">Open dashboard</a></p></div>`));
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

function resultMarkup(lastResult?: string): string {
  if (!lastResult
    || lastResult === "No full reset is due"
    || lastResult === "OAuth setup completed; full resets loaded") {
    return "";
  }
  return `<section class="result"><span class="label">Recent activity</span><p>${escapeHtml(lastResult)}</p></section>`;
}

function creditListMarkup(credits?: Array<{ expiresAt: string }>): string {
  if (!credits?.length) return "";
  const rows = credits.map((credit, index) => {
    const dialogId = `consume-credit-${index}`;
    const expiresAt = escapeHtml(credit.expiresAt);
    return `<div class="credit-row"><span class="credit-label"><span class="credit-name">Full reset ${index + 1}</span>${index === 0 ? '<span class="next-badge">Auto-redeems next</span>' : ""}</span><span class="credit-controls"><span class="credit-expiry">${timeMarkup(credit.expiresAt, true)}<span class="hint"></span></span><button class="secondary small" type="button" data-open-dialog="${dialogId}">Use reset</button></span></div><dialog id="${dialogId}"><div class="dialog-content"><span class="dialog-icon">!</span><h2>Are you sure?</h2><p>Use the full reset expiring ${timeMarkup(credit.expiresAt)} now? This cannot be undone.</p><div class="dialog-actions"><button class="secondary" type="button" data-close-dialog>Cancel</button><form method="post" action="/consume"><input type="hidden" name="confirm" value="consume"><input type="hidden" name="expiresAt" value="${expiresAt}"><button class="danger-fill" type="submit">Use reset</button></form></div></div></dialog>`;
  }).join("");
  return `<details class="credit-list"><summary>Show all ${credits.length} full reset ${credits.length === 1 ? "expiry" : "expiries"}</summary><div class="credit-rows">${rows}</div></details>`;
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
    .metric-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:9px}
    .metric-head form{margin:0}
    .metric-head .label{margin:0}
    .label{display:block;margin-bottom:9px;color:#969696;font-size:.75rem;font-weight:750;letter-spacing:.07em;text-transform:uppercase}
    .value{display:block;color:#fafafa;font-size:1rem;font-weight:650;overflow-wrap:anywhere}
    .value.large{font-size:2rem;line-height:1}
    .hint{display:block;margin-top:5px;color:#777;font-size:.78rem}
    .hint.inline{display:inline;margin:0 0 0 4px}
    .credit-list{margin:0 0 16px;border:1px solid #2b2b2b;border-radius:14px;background:#141414;overflow:hidden}
    .credit-list summary{padding:15px 18px;color:#c8c8c8;font-size:.88rem;font-weight:700;cursor:pointer;user-select:none}
    .credit-list[open] summary{border-bottom:1px solid #292929}
    .credit-rows{padding:0 18px}
    .credit-row{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:13px 0;border-bottom:1px solid #252525}
    .credit-row:last-of-type{border-bottom:0}
    .credit-label{display:flex;align-items:center;flex-wrap:wrap;gap:8px}
    .credit-name{color:#929292;font-size:.82rem;font-weight:700}
    .next-badge{padding:4px 7px;border:1px solid #285b3c;border-radius:999px;background:#12291b;color:#82e9a6;font-size:.68rem;font-weight:750;white-space:nowrap}
    .credit-controls{display:flex;align-items:center;gap:12px}
    .credit-expiry{text-align:right;font-size:.88rem;font-weight:600}
    .credit-expiry .hint{margin-top:2px}
    dialog{width:min(440px,calc(100% - 32px));padding:0;border:1px solid #3a3a3a;border-radius:18px;background:#151515;color:#f5f5f5;box-shadow:0 28px 90px #000c}
    dialog::backdrop{background:#000a;backdrop-filter:blur(3px)}
    .dialog-content{padding:26px}
    .dialog-icon{display:grid;place-items:center;width:34px;height:34px;margin-bottom:16px;border-radius:50%;background:#3b2020;color:#ff9a9a;font-weight:850}
    .dialog-content h2{margin:0 0 8px;font-size:1.35rem}
    .dialog-content p{color:#aaa}
    .dialog-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:24px}
    .dialog-actions form{margin:0}
    button.secondary{border-color:#3b3b3b;background:#202020;color:#ddd}
    button.small{min-height:34px;padding:0 11px;font-size:.78rem}
    button.icon{width:28px;min-height:28px;padding:0;border-color:#353535;background:#202020;color:#aaa;font-size:1rem;line-height:1}
    button.danger-fill{background:#c83b3b;color:white}
    .result{margin:0 0 18px;padding:17px 18px;border:1px solid #2b2b2b;border-radius:14px;background:#141414}
    .result p{font-weight:600;overflow-wrap:anywhere}
    .settings-panel{position:relative;margin:0 0 24px;padding:15px 17px;border:1px solid #292929;border-radius:14px;background:#121212}
    .settings-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
    .settings-head .label{margin:0}
    .settings{display:flex;flex-wrap:wrap;gap:8px}
    .settings-actions{display:flex;justify-content:flex-start;margin-top:13px;padding-top:13px;border-top:1px solid #272727}
    .chip{padding:6px 9px;border-radius:7px;background:#1a1a1a;border:1px solid #2c2c2c;color:#a7a7a7;font-size:.78rem}
    .settings-help{position:relative}
    .settings-help summary{display:grid;place-items:center;width:23px;height:23px;border:1px solid #3a3a3a;border-radius:50%;color:#aaa;font-size:.75rem;font-weight:800;cursor:pointer;list-style:none}
    .settings-help summary::-webkit-details-marker{display:none}
    .settings-help[open] summary{border-color:#555;color:#eee}
    .settings-tip{position:absolute;z-index:2;right:0;top:31px;width:min(340px,calc(100vw - 70px));padding:12px 13px;border:1px solid #393939;border-radius:10px;background:#202020;color:#bcbcbc;box-shadow:0 12px 34px #0009;font-size:.78rem;line-height:1.5}
    .settings-tip code{padding:1px 4px;border:0;border-radius:4px;background:#2a2a2a;font-size:.72rem;letter-spacing:0}
    button,a.button{appearance:none;display:inline-flex;align-items:center;justify-content:center;min-height:42px;border:1px solid transparent;border-radius:9px;padding:0 15px;background:#2780ff;color:white;text-decoration:none;font:inherit;font-size:.9rem;font-weight:700;cursor:pointer;transition:filter .15s,border-color .15s,background .15s}
    button:hover,a.button:hover{filter:brightness(1.1)}
    button.danger{border-color:#5f2525;background:transparent;color:#f28c8c}
    code{display:inline-block;padding:8px 11px;border:1px solid #343434;border-radius:9px;background:#191919;font-size:1.35rem;letter-spacing:.08em;user-select:all}
    .muted{color:#8d8d8d}
    .setup{display:grid;gap:18px}
    .device-code-row{display:flex;align-items:center;gap:10px}
    .device-code-row code{min-width:0}
    .device-expiry{color:#8d8d8d;font-size:.9rem}
    footer{margin-top:22px;color:#666;font-size:.75rem;text-align:center}
    footer a{color:#888;text-decoration:none}
    footer a:hover{color:#bbb;text-decoration:underline}
    @media(max-width:640px){body{padding:18px 12px}main{padding:22px;border-radius:16px}.header{align-items:flex-start;flex-direction:column}.metrics{grid-template-columns:1fr}.credit-row{align-items:flex-start;flex-direction:column}.credit-controls{width:100%;justify-content:space-between}.device-code-row{align-items:stretch;flex-direction:column}.device-code-row button{width:100%}}
  </style>
</head>
<body>
  <main>${content}<footer>Unofficial, made by <a href="https://x.com/marc_krenn" target="_blank" rel="noopener noreferrer">@marc_krenn</a>. Use at your own risk. <a href="https://github.com/marckrenn/codex-auto-reset-vercel" target="_blank" rel="noopener noreferrer">Source on GitHub</a>.</footer></main>
  <script>
    const rtf=new Intl.RelativeTimeFormat(undefined,{numeric:'auto'});
    function relative(date){const seconds=(date-Date.now())/1000;const abs=Math.abs(seconds);if(abs>=86400)return rtf.format(Math.round(seconds/86400),'day');if(abs>=3600)return rtf.format(Math.round(seconds/3600),'hour');if(abs>=60)return rtf.format(Math.round(seconds/60),'minute');return rtf.format(Math.round(seconds),'second')}
    document.querySelectorAll('time[data-local]').forEach((element)=>{const date=new Date(element.dateTime);if(!Number.isFinite(date.getTime()))return;element.title=date.toISOString();element.textContent=new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'}).format(date);if(element.hasAttribute('data-relative')){const hint=element.parentElement?.querySelector('.hint');if(hint)hint.textContent=hint.classList.contains('inline')?'('+relative(date)+')':relative(date)}});
    document.querySelectorAll('[data-copy-target]').forEach((button)=>button.addEventListener('click',async()=>{const target=document.getElementById(button.dataset.copyTarget);if(!target)return;try{await navigator.clipboard.writeText(target.textContent||'');const previous=button.textContent;button.textContent='Copied';setTimeout(()=>button.textContent=previous,1500)}catch{const selection=getSelection();const range=document.createRange();range.selectNodeContents(target);selection?.removeAllRanges();selection?.addRange(range)}}));
    document.querySelectorAll('[data-open-dialog]').forEach((button)=>button.addEventListener('click',()=>document.getElementById(button.dataset.openDialog)?.showModal()));
    document.querySelectorAll('[data-close-dialog]').forEach((button)=>button.addEventListener('click',()=>button.closest('dialog')?.close()));
    document.querySelectorAll('dialog').forEach((dialog)=>dialog.addEventListener('click',(event)=>{if(event.target===dialog)dialog.close()}));
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
<p class="intro">Automatically redeems Codex resets before they expire.</p>
<section class="metrics" aria-label="Full reset status">
  <div class="metric"><span class="label">Available full resets</span><strong class="value large">${summary.availableCount ?? "—"}</strong></div>
  <div class="metric"><span class="label">Next expiry</span><strong class="value">${timeMarkup(summary.nextExpiry, true)}<span class="hint"></span></strong></div>
  <div class="metric"><div class="metric-head"><span class="label">Last check</span><form method="post" action="/check"><button class="icon" type="submit" aria-label="Check now" title="Check now">↻</button></form></div><strong class="value">${timeMarkup(summary.lastCheckAt, true)}<span class="hint"></span></strong></div>
</section>
${creditListMarkup(summary.availableCredits)}
${resultMarkup(summary.lastResult)}
<section class="settings-panel" aria-label="Settings"><div class="settings-head"><span class="label">Settings</span><details class="settings-help"><summary aria-label="How to change settings">?</summary><div class="settings-tip">Change <code>CHECK_INTERVAL_MINUTES</code> and <code>REDEEM_LEAD_MINUTES</code> under Vercel → Project Settings → Environment Variables, then redeploy.</div></details></div><div class="settings"><span class="chip">Check every ${interval} min</span><span class="chip">Redeem in final ${lead} min</span></div><div class="settings-actions"><button class="danger small" type="button" data-open-dialog="disconnect-codex-dialog">Disconnect Codex</button></div></section>
<dialog id="disconnect-codex-dialog"><div class="dialog-content"><span class="dialog-icon">!</span><h2>Are you sure?</h2><p>Disconnect Codex and remove the stored OAuth credential, schedule, and redemption state? You will need to connect again to resume automatic resets.</p><div class="dialog-actions"><button class="secondary" type="button" data-close-dialog>Cancel</button><form method="post" action="/reset"><input type="hidden" name="confirm" value="reset"><button class="danger-fill" type="submit">Disconnect Codex</button></form></div></div></dialog>`);
    return;
  }

  if (view.deviceFlow) {
    const flow = view.deviceFlow;
    const retryMs = Math.max(1_000, flow.nextPollAt - Date.now());
    sendPage(response, `<div class="header"><h1>Connect Codex</h1></div><div class="setup"><p>Open the official OpenAI page and enter this device code:</p><p><a class="button" href="https://auth.openai.com/codex/device" target="_blank" rel="noopener noreferrer">Open OpenAI device login</a></p><div class="device-code-row"><code id="device-code">${escapeHtml(flow.userCode)}</code><button class="secondary small" type="button" data-copy-target="device-code">Copy</button></div><p class="device-expiry">Expires ${timeMarkup(flow.expiresAt, true)}<span class="hint inline"></span>. Approval is checked automatically.</p><p id="status">Waiting for approval…</p></div><script>const status=document.getElementById('status');async function check(){try{const response=await fetch('/setup/status',{method:'POST',credentials:'same-origin'});const result=await response.json();if(result.status==='configured'){location.reload();return}status.textContent=result.message||'Waiting for approval…';setTimeout(check,Math.max(1000,result.retryAfterMs||${flow.intervalMs}))}catch{status.textContent='Status check failed; retrying…';setTimeout(check,5000)}}setTimeout(check,${retryMs});</script>`);
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

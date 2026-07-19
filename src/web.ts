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
    :root{font-family:"IBM Plex Sans",Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#f4f4f5;background:#151517;color-scheme:dark;font-synthesis:none}
    *{box-sizing:border-box}
    body{min-height:100vh;margin:0;padding:56px 20px;background:radial-gradient(circle at 50% -12%,#ffffff0d 0,transparent 34rem),linear-gradient(#ffffff05 1px,transparent 1px),linear-gradient(90deg,#ffffff05 1px,transparent 1px),#151517;background-size:auto,64px 64px,64px 64px;line-height:1.5}
    main{position:relative;width:min(820px,100%);margin:0 auto;overflow:hidden;border:1px solid #29292d;border-radius:24px;background:#1a1a1d;padding:34px;box-shadow:inset 0 1px 0 #ffffff0a,0 28px 90px #0006}
    main::before{position:absolute;inset:0 18% auto;height:1px;content:"";background:linear-gradient(90deg,transparent,#ffffff24,transparent)}
    h1{display:flex;align-items:center;gap:12px;margin:0;font-family:"Space Grotesk","IBM Plex Sans",ui-sans-serif,system-ui,sans-serif;font-size:clamp(1.75rem,5vw,2.25rem);font-weight:650;letter-spacing:-.045em}
    h1::before{width:32px;height:32px;flex:0 0 auto;border-radius:8px;content:"";background:radial-gradient(circle at 36% 45%,#18181b 0 2px,transparent 2.5px),radial-gradient(circle at 64% 45%,#18181b 0 2px,transparent 2.5px),linear-gradient(#18181b,#18181b) 50% 68%/12px 2px no-repeat,#fff;box-shadow:inset 0 0 0 1px #ffffff40}
    p{margin:0}
    .header{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:30px}
    .status{display:inline-flex;align-items:center;gap:8px;padding:6px 10px;border:1px solid #166534;border-radius:999px;background:#052e1699;color:#4ade80;font-size:.76rem;font-weight:700;letter-spacing:.03em;white-space:nowrap}
    .status-dot{width:7px;height:7px;border-radius:50%;background:#22c55e;box-shadow:0 0 0 4px #22c55e1f}
    .intro{margin:-13px 0 26px;color:#a1a1aa;font-size:.95rem}
    .metrics{display:grid;grid-template-columns:.7fr 1.3fr 1.3fr;gap:12px;margin:0 0 16px}
    .metric{min-width:0;padding:19px;border:1px solid #29292d;border-radius:14px;background:#18181b;box-shadow:inset 0 1px 0 #ffffff08}
    .metric-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px}
    .metric-head form{margin:0}
    .metric-head .label{margin:0}
    .label{display:block;margin-bottom:10px;color:#85858f;font-size:.7rem;font-weight:750;letter-spacing:.12em;text-transform:uppercase}
    .value{display:block;color:#fafafa;font-size:1rem;font-weight:650;overflow-wrap:anywhere}
    .value.large{font-family:"Space Grotesk",ui-sans-serif,system-ui,sans-serif;font-size:2.15rem;line-height:1}
    .hint{display:block;margin-top:5px;color:#71717a;font-size:.78rem}
    .hint.inline{display:inline;margin:0 0 0 4px}
    .credit-list{margin:0 0 16px;overflow:hidden;border:1px solid #29292d;border-radius:14px;background:#18181b}
    .credit-list summary{padding:15px 18px;color:#d4d4d8;font-size:.86rem;font-weight:650;cursor:pointer;user-select:none}
    .credit-list[open] summary{border-bottom:1px solid #29292d}
    .credit-rows{padding:0 18px}
    .credit-row{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:14px 0;border-bottom:1px solid #27272a}
    .credit-row:last-of-type{border-bottom:0}
    .credit-label{display:flex;align-items:center;flex-wrap:wrap;gap:8px}
    .credit-name{color:#a1a1aa;font-size:.82rem;font-weight:650}
    .next-badge{padding:4px 7px;border:1px solid #166534;border-radius:999px;background:#052e1699;color:#4ade80;font-size:.66rem;font-weight:750;white-space:nowrap}
    .credit-controls{display:flex;align-items:center;gap:12px}
    .credit-expiry{text-align:right;font-size:.88rem;font-weight:600}
    .credit-expiry .hint{margin-top:2px}
    dialog{width:min(440px,calc(100% - 32px));padding:0;border:1px solid #3f3f46;border-radius:18px;background:#1b1b1e;color:#f4f4f5;box-shadow:0 28px 90px #000c}
    dialog::backdrop{background:#000b;backdrop-filter:blur(4px)}
    .dialog-content{padding:27px}
    .dialog-icon{display:grid;place-items:center;width:34px;height:34px;margin-bottom:16px;border-radius:50%;background:#3f1d20;color:#fda4af;font-weight:850}
    .dialog-content h2{margin:0 0 8px;font-family:"Space Grotesk",ui-sans-serif,system-ui,sans-serif;font-size:1.35rem}
    .dialog-content p{color:#a1a1aa}
    .dialog-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:24px}
    .dialog-actions form{margin:0}
    button.secondary{border-color:#3f3f46;background:#1d1d20;color:#e4e4e7}
    button.small{min-height:34px;padding:0 12px;font-size:.78rem}
    button.icon{width:30px;min-height:30px;padding:0;border-color:#3f3f46;background:#1d1d20;color:#a1a1aa;font-size:1rem;line-height:1}
    button.danger-fill{background:#be3341;color:white}
    .result{margin:0 0 18px;padding:17px 18px;border:1px solid #29292d;border-radius:14px;background:#18181b}
    .result p{font-weight:600;overflow-wrap:anywhere}
    .settings-panel{position:relative;margin:0 0 24px;padding:16px 18px;border:1px solid #29292d;border-radius:14px;background:#18181b}
    .settings-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:11px}
    .settings-head .label{margin:0}
    .settings{display:flex;flex-wrap:wrap;gap:8px}
    .settings-actions{display:flex;justify-content:flex-start;margin-top:14px;padding-top:14px;border-top:1px solid #29292d}
    .chip{padding:6px 9px;border:1px solid #303036;border-radius:8px;background:#1e1e21;color:#a1a1aa;font-size:.77rem}
    .settings-help{position:relative}
    .settings-help summary{display:grid;place-items:center;width:24px;height:24px;border:1px solid #3f3f46;border-radius:50%;color:#a1a1aa;font-size:.75rem;font-weight:800;cursor:pointer;list-style:none}
    .settings-help summary::-webkit-details-marker{display:none}
    .settings-help[open] summary{border-color:#71717a;color:#f4f4f5}
    .settings-tip{position:absolute;z-index:2;right:0;top:32px;width:min(340px,calc(100vw - 70px));padding:13px 14px;border:1px solid #3f3f46;border-radius:10px;background:#242427;color:#c4c4cc;box-shadow:0 12px 34px #0009;font-size:.78rem;line-height:1.5}
    .settings-tip code{padding:1px 4px;border:0;border-radius:4px;background:#303036;font-size:.72rem;letter-spacing:0}
    button,a.button{appearance:none;display:inline-flex;align-items:center;justify-content:center;min-height:44px;border:1px solid #ffffff24;border-radius:10px;padding:0 17px;background:#f4f4f5;color:#18181b;text-decoration:none;font:inherit;font-size:.88rem;font-weight:700;cursor:pointer;transition:transform .15s,filter .15s,border-color .15s,background .15s}
    button:hover,a.button:hover{transform:translateY(-1px);filter:brightness(.94)}
    button.danger{border-color:#7f1d2d;background:transparent;color:#fda4af}
    code{display:inline-block;padding:9px 12px;border:1px solid #3f3f46;border-radius:10px;background:#18181b;color:#fafafa;font-size:1.35rem;letter-spacing:.08em;user-select:all}
    .muted{color:#8f8f99}
    .setup{display:grid;gap:19px}
    .device-code-row{display:flex;align-items:center;gap:10px}
    .device-code-row code{min-width:0}
    .device-expiry{color:#8f8f99;font-size:.9rem}
    .device-approval{display:block;margin-top:4px}
    footer{margin-top:26px;padding-top:19px;border-top:1px solid #29292d;color:#66666f;font-size:.72rem;text-align:center}
    footer a{color:#8f8f99;text-decoration:none}
    footer a:hover{color:#d4d4d8;text-decoration:underline}
    @media(max-width:640px){body{padding:18px 12px;background-size:auto,48px 48px,48px 48px}main{padding:22px 20px;border-radius:18px}.header{gap:12px}.header h1{font-size:1.4rem}.header h1::before{width:28px;height:28px;border-radius:7px}.status{padding:5px 8px}.metrics{grid-template-columns:1fr}.credit-row{align-items:flex-start;flex-direction:column}.credit-controls{width:100%;justify-content:space-between}.device-code-row{align-items:stretch;flex-direction:column}.device-code-row button{width:100%}}
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
    sendPage(response, `<div class="header"><h1>Connect Codex</h1></div><div class="setup"><p>First, copy this device code:</p><div class="device-code-row"><code id="device-code">${escapeHtml(flow.userCode)}</code><button class="secondary small" type="button" data-copy-target="device-code">Copy</button></div><p class="device-expiry">Expires ${timeMarkup(flow.expiresAt, true)}<span class="hint inline"></span>.<span class="device-approval">Approval is checked automatically.</span></p><p>Then, open OpenAI's device login page:</p><p><a class="button" href="https://auth.openai.com/codex/device" target="_blank" rel="noopener noreferrer">Open OpenAI device login</a></p><p id="status">Waiting for approval…</p></div><script>const status=document.getElementById('status');async function check(){try{const response=await fetch('/setup/status',{method:'POST',credentials:'same-origin'});const result=await response.json();if(result.status==='configured'){location.reload();return}status.textContent=result.message||'Waiting for approval…';setTimeout(check,Math.max(1000,result.retryAfterMs||${flow.intervalMs}))}catch{status.textContent='Status check failed; retrying…';setTimeout(check,5000)}}setTimeout(check,${retryMs});</script>`);
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

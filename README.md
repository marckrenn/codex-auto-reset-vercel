# Codex Auto Reset for Vercel

A private, user-owned Vercel deployment that checks ChatGPT reset credits every five minutes and consumes the earliest available credit during its final ten minutes.

> This uses undocumented OpenAI endpoints and an unofficial device-code OAuth flow. OpenAI may change or disable them at any time.

## Deploy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fmarckrenn%2Fcodex-auto-reset-vercel&project-name=codex-auto-reset&repository-name=codex-auto-reset&demo-title=Codex+Auto+Reset&demo-description=User-owned+Vercel+deployment+for+automatically+redeeming+expiring+Codex+reset+credits.&env=MASTER_KEY&envDescription=Enter+a+random+secret+of+at+least+32+characters.+This+encrypts+OAuth+credentials+and+is+also+the+setup+password.&stores=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22upstash%22%2C%22productSlug%22%3A%22upstash-kv%22%2C%22protocol%22%3A%22storage%22%2C%22allowConnectExistingProduct%22%3Atrue%7D%2C%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22upstash%22%2C%22productSlug%22%3A%22upstash-qstash%22%2C%22allowConnectExistingProduct%22%3Atrue%7D%5D)

The deployment flow provisions the Upstash Redis and QStash products and asks for one user-created `MASTER_KEY`. The source repository must be public before unaffiliated users can deploy it.

## Architecture

- **Vercel Node Functions** — setup UI and reset checks
- **Upstash Redis** — encrypted OAuth credentials, summaries, and stable redemption IDs
- **Upstash QStash** — signed five-minute schedule
- **AES-GCM** — credentials encrypted with a key derived from `MASTER_KEY`

Each user deploys into their own Vercel and Upstash accounts. No shared credential service is involved.

## Safety properties

- OAuth access and refresh tokens are encrypted before Redis storage.
- Rotated refresh tokens are stored before subsequent API calls.
- A stable `redeem_request_id` is persisted before every consume request and reused after ambiguous failures.
- QStash requests require a valid signature and matching destination URL.
- Setup mutations require HTTP Basic authentication and same-origin requests.
- A Redis lock serializes setup, checks, and redemption.
- Remote responses have timeout and size limits.
- UI summaries never include tokens or raw remote response bodies.

## Manual private deployment setup

Requirements: Node.js, npm, Vercel CLI access, and a Vercel account.

```bash
npm install
vercel link
vercel integration add upstash/upstash-kv
vercel integration add upstash/upstash-qstash
openssl rand -base64 32 | vercel env add MASTER_KEY production
vercel deploy --prod
```

Open the production URL and authenticate with:

- username: `admin`
- password: the configured `MASTER_KEY`

Complete **Start Codex login**. The application performs an immediate read-only inventory check and creates its QStash schedule automatically.

## Optional settings

Set these under **Vercel → Project → Settings → Environment Variables**, then redeploy:

| Variable | Default | Allowed | Purpose |
| --- | ---: | ---: | --- |
| `CHECK_INTERVAL_MINUTES` | `5` | `1`–`60` | QStash inventory-check interval |
| `REDEEM_LEAD_MINUTES` | `10` | `1`–`60` | How close to expiry a credit becomes eligible |

The app automatically replaces an existing QStash schedule when the interval changes. A one-minute interval exceeds QStash's current free daily message allowance; five minutes is recommended.

The OpenAI device-login polling interval is not configurable because OpenAI supplies it.

## Development

```bash
npm install
bun test
npm run typecheck
```

## Expected free-tier usage

A five-minute schedule uses approximately 288 QStash messages per day. State storage is very small. A user's first Redis and QStash resources should fit current Upstash free allowances; additional resources in the same account may require a pay-as-you-go plan and payment method. Provider limits and pricing can change.

Vercel Hobby is intended for personal, non-commercial use.

## Undocumented endpoints

- `GET https://chatgpt.com/backend-api/wham/rate-limit-reset-credits`
- `POST https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume`

This project is not affiliated with or endorsed by OpenAI, Vercel, or Upstash.

## License

[MIT](LICENSE)

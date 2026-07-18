# Codex Auto Reset for Vercel

A private, user-owned Vercel deployment that checks ChatGPT reset credits every five minutes and consumes the earliest available credit during its final ten minutes.

> This uses undocumented OpenAI endpoints and an unofficial device-code OAuth flow. OpenAI may change or disable them at any time.

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

## Current private deployment setup

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

## Development

```bash
npm install
bun test
npm run typecheck
```

## Expected free-tier usage

A five-minute schedule uses approximately 288 QStash messages per day. State storage is very small. This should fit current Vercel Hobby and Upstash free allowances for personal use, but provider limits and pricing can change.

Vercel Hobby is intended for personal, non-commercial use.

## Undocumented endpoints

- `GET https://chatgpt.com/backend-api/wham/rate-limit-reset-credits`
- `POST https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume`

This project is not affiliated with or endorsed by OpenAI, Vercel, or Upstash.

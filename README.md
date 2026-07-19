# Codex Auto Reset for Vercel

**Put every Codex reset to use.**

Your always-on service automatically redeems eligible Codex full resets before they expire – even while you or your computer sleeps.

**Beta** · [Website](https://codex-auto-reset.marckrenn.dev) · [Docker edition](https://github.com/marckrenn/codex-auto-reset-docker) · [Latest release](https://github.com/marckrenn/codex-auto-reset-vercel/releases/latest)

> [!WARNING]
> **Codex Auto Reset uses private API.** This independent project uses undocumented OpenAI endpoints and an unofficial device-login flow. OpenAI can change or disable them at any time. Use at your own risk.

## Why Vercel?

- **Free\*** for typical personal use within current Vercel and Upstash allowances
- **1-click deploy** with Redis and scheduling included
- **~2 min setup** before connecting Codex
- User-owned deployment, storage, and encryption key

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fmarckrenn%2Fcodex-auto-reset-vercel&project-name=codex-auto-reset&repository-name=codex-auto-reset&demo-title=Codex+Auto+Reset&demo-description=User-owned+Vercel+deployment+for+automatically+redeeming+expiring+Codex+full+resets.&env=MASTER_KEY&envDescription=Enter+a+random+secret+of+at+least+32+characters.+This+encrypts+OAuth+credentials+and+is+also+the+setup+password.&stores=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22upstash%22%2C%22productSlug%22%3A%22upstash-kv%22%2C%22envVarPrefix%22%3A%22KV%22%2C%22protocol%22%3A%22storage%22%2C%22allowConnectExistingProduct%22%3Atrue%7D%2C%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22upstash%22%2C%22productSlug%22%3A%22upstash-qstash%22%2C%22envVarPrefix%22%3A%22QSTASH%22%2C%22allowConnectExistingProduct%22%3Atrue%7D%5D)

\* Provider limits and pricing can change. Vercel Hobby is intended for personal, non-commercial use.

## Choose your edition

| Edition | Best for | Setup |
| --- | --- | --- |
| **Vercel** | The quickest path with managed functions, Redis, and scheduling | 1-click deploy, ~2 min setup |
| [Docker](https://github.com/marckrenn/codex-auto-reset-docker) | Running everything on your own always-on server | One container, one persistent volume |

Run only **one active Codex Auto Reset deployment per OpenAI account** to avoid competing redeemers.

> [!IMPORTANT]
> **Device authorization must be enabled.** Before connecting Codex, open [ChatGPT Security settings](https://chatgpt.com/#settings/Security) and turn on **Enable device code authorization for Codex** near the bottom.

## Quick start

1. Select **Deploy with Vercel** above.
2. Let Vercel provision the Upstash Redis and QStash integrations.
3. Enter a random `MASTER_KEY` with at least 32 characters.
4. Enable **Enable device code authorization for Codex** in [ChatGPT Security settings](https://chatgpt.com/#settings/Security).
5. Open the deployed dashboard and authenticate with:
   - username: `admin`
   - password: your `MASTER_KEY`
6. Select **Start Codex login** and approve the device code on OpenAI's website.

Authentication happens directly on OpenAI's website. Codex Auto Reset never receives your OpenAI password.

Once connected, the service loads your full-reset inventory and creates its five-minute QStash schedule automatically.

## How it works

- **Vercel Functions** provide the protected setup, status, and reset endpoints.
- **Upstash Redis** stores encrypted OAuth credentials, summary state, and stable redemption IDs.
- **Upstash QStash** invokes the signed scheduled check every five minutes.
- **AES-GCM** encrypts OAuth credentials using a key derived from `MASTER_KEY`.
- The earliest eligible full reset is redeemed during its final ten minutes by default.

Every deployment belongs to its owner. There is no shared credential service or central database.

## Configuration

Set optional variables under **Vercel → Project → Settings → Environment Variables**, then redeploy:

| Variable | Default | Allowed | Purpose |
| --- | ---: | ---: | --- |
| `CHECK_INTERVAL_MINUTES` | `5` | `1`–`60` | Inventory-check and QStash schedule interval |
| `REDEEM_LEAD_MINUTES` | `10` | `1`–`60` | How close to expiry a full reset becomes eligible |
| `STATE_NAMESPACE` | unset | letters, numbers, `_`, `-` | Isolates deployments intentionally sharing one Redis database |

Most users should leave `STATE_NAMESPACE` unset. Never change it after OAuth setup.

The application replaces the existing QStash schedule when the interval changes. A one-minute interval exceeds QStash's current free daily-message allowance; five minutes is recommended. OpenAI controls the device-login polling interval.

## Manual deployment

Requirements: Node.js 24, npm, Vercel CLI access, and a Vercel account.

```bash
npm install
vercel link
vercel integration add upstash/upstash-kv
vercel integration add upstash/upstash-qstash
openssl rand -base64 32 | vercel env add MASTER_KEY production
vercel deploy --prod
```

Open the production URL, sign in with `admin` and the configured `MASTER_KEY`, then complete **Start Codex login**.

## Safety properties

- OAuth access and refresh tokens are encrypted before Redis storage.
- Rotated refresh tokens are stored before subsequent API calls.
- A stable `redeem_request_id` is persisted before each consume request and reused after ambiguous failures.
- QStash requests require a valid signature and matching destination URL.
- Setup and redemption mutations require Basic authentication and same-origin requests.
- A Redis lock serializes setup, checks, and redemption.
- Remote responses have timeout and size limits.
- Dashboard summaries never include tokens or raw remote response bodies.

`MASTER_KEY` is both the dashboard password and the root of credential encryption. Store it securely. Replacing it makes existing encrypted credentials unreadable until the state is reset and Codex is connected again.

## Expected free-tier usage

A five-minute schedule uses approximately 288 QStash messages per day, and Redis state is very small. A user's first Redis and QStash resources should fit current free allowances. Additional resources in the same account may require a paid plan or payment method.

## Development

Development uses [Bun](https://bun.sh/):

```bash
npm install
bun test
npm run typecheck
npx vercel dev
```

## Undocumented endpoints

- `GET https://chatgpt.com/backend-api/wham/rate-limit-reset-credits`
- `POST https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume`

This project is independent and is not affiliated with or endorsed by OpenAI, Vercel, or Upstash.

## Support

Questions or feedback: [@marc_krenn](https://x.com/marc_krenn), publicly or by DM.

Support development through [GitHub Sponsors](https://github.com/sponsors/marckrenn) or [Buy Me a Coffee](https://buymeacoffee.com/marckrenn).

## License

[MIT](LICENSE)

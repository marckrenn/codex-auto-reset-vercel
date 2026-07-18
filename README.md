# Codex Auto Reset — Vercel compatibility probe

Private, read-only probe used to verify whether a Vercel Node function can access the unofficial ChatGPT reset-credit inventory endpoint.

The probe:

1. performs Codex device-code OAuth;
2. keeps temporary device-flow state in an AES-GCM encrypted HttpOnly cookie;
3. performs one `GET /backend-api/wham/rate-limit-reset-credits` request;
4. does not consume credits or persist OAuth credentials.

## Local checks

```bash
bun install
bun test
bun run typecheck
```

## Environment

Set a high-entropy `MASTER_KEY` of at least 32 characters. The setup username is `admin` and the password is this key.

This uses undocumented OpenAI endpoints and is not an official OpenAI integration.

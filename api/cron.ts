import type { VercelRequest, VercelResponse } from "../src/vercel-types";
import { ensureSchedule, qstashReceiver } from "../src/qstash";
import { runScheduledReset } from "../src/service";
import { masterKey, requestOrigin, setSecurityHeaders, withStore } from "../src/web";

function rawBody(request: VercelRequest): string {
  if (typeof request.body === "string") return request.body;
  if (request.body instanceof Buffer) return request.body.toString("utf8");
  return request.body === undefined ? "" : JSON.stringify(request.body);
}

export default async function handler(request: VercelRequest, response: VercelResponse): Promise<void> {
  setSecurityHeaders(response);
  if (request.method !== "POST") {
    response.status(405).send("Method not allowed");
    return;
  }

  const signature = Array.isArray(request.headers["upstash-signature"])
    ? request.headers["upstash-signature"][0]
    : request.headers["upstash-signature"];
  if (!signature) {
    response.status(401).send("Invalid scheduler signature");
    return;
  }

  try {
    const valid = await qstashReceiver().verify({
      signature,
      body: rawBody(request),
      url: new URL("/cron", requestOrigin(request)).toString(),
    });
    if (!valid) throw new Error("Invalid scheduler signature");
  } catch {
    response.status(401).send("Invalid scheduler signature");
    return;
  }

  try {
    await withStore(async (store) => {
      await ensureSchedule(store, requestOrigin(request));
      await runScheduledReset(store, masterKey());
    });
    response.status(204).send("");
  } catch {
    response.status(503).send("Scheduled check failed");
  }
}

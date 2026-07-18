import type { VercelRequest, VercelResponse } from "@vercel/node";
import { ensureSchedule } from "../src/qstash";
import { advanceSetup, getServiceView } from "../src/service";
import { requestOrigin, requireMutation, sendJson, withStore } from "../src/web";

export default async function handler(request: VercelRequest, response: VercelResponse): Promise<void> {
  const key = requireMutation(request, response);
  if (!key) return;
  try {
    const result = await withStore(async (store) => {
      const status = await advanceSetup(store, key);
      if (status === "configured") await ensureSchedule(store, requestOrigin(request));
      return { status, view: await getServiceView(store, key) };
    });
    sendJson(response, {
      status: result.status,
      message: result.status === "configured" ? "OAuth setup completed" : "Waiting for OpenAI approval…",
      retryAfterMs: result.view.deviceFlow
        ? Math.max(1_000, result.view.deviceFlow.nextPollAt - Date.now())
        : 1_000,
    });
  } catch (error) {
    const expired = error instanceof Error && error.message === "OAuth device flow expired";
    sendJson(response, {
      status: "error",
      message: expired ? "Device login expired; reload and start again" : "Setup check failed; retry or reload",
      retryAfterMs: 5_000,
    }, expired ? 410 : 502);
  }
}

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { ensureSchedule } from "../src/qstash";
import { getServiceView } from "../src/service";
import { renderRecovery, renderService, requestOrigin, requirePageAuth, sendPage, withStore } from "../src/web";

export default async function handler(request: VercelRequest, response: VercelResponse): Promise<void> {
  const key = requirePageAuth(request, response);
  if (!key) return;
  if (request.method !== "GET") {
    sendPage(response, "<p>Method not allowed</p>", 405);
    return;
  }

  try {
    const view = await withStore(async (store) => {
      const current = await getServiceView(store, key);
      if (current.configured) await ensureSchedule(store, requestOrigin(request));
      return current;
    });
    renderService(response, view);
  } catch (error) {
    if (error instanceof Error && error.message === "Unable to decrypt credential") {
      renderRecovery(response);
      return;
    }
    sendPage(response, "<p>Unable to load service state. Retry shortly.</p>", 503);
  }
}

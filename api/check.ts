import type { VercelRequest, VercelResponse } from "@vercel/node";
import { runScheduledReset } from "../src/service";
import { redirect, requireMutation, sendPage, withStore } from "../src/web";

export default async function handler(request: VercelRequest, response: VercelResponse): Promise<void> {
  const key = requireMutation(request, response);
  if (!key) return;
  try {
    await withStore((store) => runScheduledReset(store, key));
    redirect(response);
  } catch {
    sendPage(response, "<p>Full reset check failed. The status page contains safe diagnostic details.</p>", 502);
  }
}

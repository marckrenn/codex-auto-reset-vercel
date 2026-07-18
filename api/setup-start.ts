import type { VercelRequest, VercelResponse } from "@vercel/node";
import { beginSetup } from "../src/service";
import { redirect, requireMutation, sendPage, withStore } from "../src/web";

export default async function handler(request: VercelRequest, response: VercelResponse): Promise<void> {
  const key = requireMutation(request, response);
  if (!key) return;
  try {
    await withStore((store) => beginSetup(store, key));
    redirect(response);
  } catch (error) {
    if (error instanceof Error && error.message === "Service is already configured") {
      redirect(response);
      return;
    }
    sendPage(response, "<p>Unable to start Codex login. Retry shortly.</p>", 502);
  }
}

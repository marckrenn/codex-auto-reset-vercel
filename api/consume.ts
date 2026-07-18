import type { VercelRequest, VercelResponse } from "../src/vercel-types";
import { consumeCreditByExpiry } from "../src/service";
import { readSmallForm, redirect, requireMutation, sendPage, withStore } from "../src/web";

export default async function handler(request: VercelRequest, response: VercelResponse): Promise<void> {
  const key = requireMutation(request, response);
  if (!key) return;

  try {
    const body = await readSmallForm(request);
    const expiresAt = body.get("expiresAt") ?? "";
    if (body.get("confirm") !== "consume" || !expiresAt) {
      sendPage(response, "<p>Reset confirmation is required.</p>", 400);
      return;
    }
    await withStore((store) => consumeCreditByExpiry(store, key, expiresAt));
    redirect(response);
  } catch {
    sendPage(response, "<p>Unable to use this full reset. Return to the dashboard for status details.</p>", 502);
  }
}

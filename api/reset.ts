import type { VercelRequest, VercelResponse } from "../src/vercel-types";
import { deleteSchedule } from "../src/qstash";
import { resetService } from "../src/service";
import { readSmallForm, redirect, requireMutation, sendPage, withStore } from "../src/web";

export default async function handler(request: VercelRequest, response: VercelResponse): Promise<void> {
  if (!requireMutation(request, response)) return;
  try {
    const body = await readSmallForm(request);
    if (body.get("confirm") !== "reset") {
      sendPage(response, "<p>Reset confirmation required</p>", 400);
      return;
    }
    await withStore(async (store) => {
      await deleteSchedule(store);
      await resetService(store);
    });
    redirect(response);
  } catch {
    sendPage(response, "<p>Reset failed. Retry shortly.</p>", 502);
  }
}

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { pollDeviceFlow } from "../src/oauth";
import { earliestAvailableExpiry } from "../src/schedule";
import { getResetCredits } from "../src/wham";
import {
  clearFlowCookie,
  decodeFlow,
  deviceContent,
  encodeFlow,
  requireMutation,
  resultContent,
  safeError,
  sendPage,
  setFlowCookie,
} from "./_shared";

export default async function handler(request: VercelRequest, response: VercelResponse): Promise<void> {
  const key = requireMutation(request, response);
  if (!key) return;

  try {
    const result = await pollDeviceFlow(await decodeFlow(request, key));
    if (result.status === "pending") {
      setFlowCookie(response, await encodeFlow(result.flow, key));
      sendPage(response, deviceContent(result.flow, "OpenAI has not approved the code yet"));
      return;
    }

    clearFlowCookie(response);
    try {
      const nowMs = Date.now();
      const credits = await getResetCredits(result.credential);
      sendPage(response, resultContent({
        ok: true,
        message: "WHAM returned valid JSON through a Vercel Node function",
        availableCount: credits.filter((credit) => credit.status === "available").length,
        nextExpiry: earliestAvailableExpiry(credits, nowMs),
      }));
    } catch (error) {
      sendPage(response, resultContent({ ok: false, message: safeError(error) }), 502);
    }
  } catch (error) {
    sendPage(response, resultContent({ ok: false, message: safeError(error) }), 502);
  }
}

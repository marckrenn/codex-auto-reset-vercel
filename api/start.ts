import type { VercelRequest, VercelResponse } from "@vercel/node";
import { startDeviceFlow } from "../src/oauth";
import { deviceContent, encodeFlow, requireMutation, resultContent, safeError, sendPage, setFlowCookie } from "./_shared";

export default async function handler(request: VercelRequest, response: VercelResponse): Promise<void> {
  const key = requireMutation(request, response);
  if (!key) return;
  try {
    const flow = await startDeviceFlow();
    setFlowCookie(response, await encodeFlow(flow, key));
    sendPage(response, deviceContent(flow));
  } catch (error) {
    sendPage(response, resultContent({ ok: false, message: safeError(error) }), 502);
  }
}

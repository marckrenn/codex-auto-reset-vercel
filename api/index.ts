import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requirePageAuth, sendPage, startContent } from "./_shared";

export default function handler(request: VercelRequest, response: VercelResponse): void {
  if (!requirePageAuth(request, response)) return;
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    response.status(405).send("Method not allowed");
    return;
  }
  sendPage(response, startContent());
}

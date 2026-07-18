import type { IncomingMessage, ServerResponse } from "node:http";

export interface VercelRequest extends IncomingMessage {
  body?: unknown;
}

export interface VercelResponse extends ServerResponse {
  status(statusCode: number): this;
  send(body: unknown): this;
  json(body: unknown): this;
}

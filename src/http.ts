import { MAX_RESPONSE_BYTES, REQUEST_TIMEOUT_MS } from "./config";
import { RequestTimeoutError, withTimeout } from "./timeout";

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type JsonResponse = {
  ok: boolean;
  status: number;
  value: unknown;
};

export class RemoteRequestError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "RemoteRequestError";
  }
}

async function readBoundedText(label: string, response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new RemoteRequestError(`${label} response exceeded size limit`, response.status);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof RemoteRequestError) throw error;
    throw new RemoteRequestError(`${label} response could not be read`, response.status);
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function fetchJson(
  label: string,
  url: string,
  init: RequestInit,
  options: { fetch?: FetchLike; timeoutMs?: number } = {},
): Promise<JsonResponse> {
  const fetchImpl = options.fetch ?? fetch;
  try {
    return await withTimeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS, async (signal) => {
      const response = await fetchImpl(url, { ...init, signal });
      const contentLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
        throw new RemoteRequestError(`${label} response exceeded size limit`, response.status);
      }

      const text = await readBoundedText(label, response);
      let value: unknown;
      if (text.trim() !== "") {
        try {
          value = JSON.parse(text);
        } catch {
          const contentType = response.headers.get("content-type")?.split(";", 1)[0] || "unknown";
          throw new RemoteRequestError(
            `${label} response was not valid JSON (HTTP ${response.status}, content-type ${contentType})`,
            response.status,
          );
        }
      }
      return { ok: response.ok, status: response.status, value };
    });
  } catch (error) {
    if (error instanceof RemoteRequestError) throw error;
    if (error instanceof RequestTimeoutError) throw new RemoteRequestError(`${label} request timed out`);
    throw new RemoteRequestError(`${label} request failed`);
  }
}

export function requireSuccess(label: string, response: JsonResponse): unknown {
  if (!response.ok) throw new RemoteRequestError(`${label} request failed (HTTP ${response.status})`, response.status);
  return response.value;
}

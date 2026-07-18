import { expect, test } from "bun:test";
import { MAX_RESPONSE_BYTES } from "../src/config";
import { fetchJson } from "../src/http";

test("rejects an oversized chunked body before buffering beyond the limit", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(MAX_RESPONSE_BYTES));
      controller.enqueue(new Uint8Array(1));
    },
    cancel() {
      cancelled = true;
    },
  });

  await expect(fetchJson("test", "https://example.test", { method: "GET" }, {
    fetch: async () => new Response(stream),
  })).rejects.toThrow("exceeded size limit");
  expect(cancelled).toBeTrue();
});

import { describe, expect, test } from "bun:test";
import { hasSameOrigin, isAuthenticated, renderService } from "../src/web";

function request(headers: Record<string, string> = {}) {
  return { headers, cookies: {} } as never;
}

class ResponseStub {
  body = "";
  statusCode = 200;
  headers = new Map<string, string>();

  setHeader(name: string, value: string) {
    this.headers.set(name, value);
    return this;
  }

  status(value: number) {
    this.statusCode = value;
    return this;
  }

  send(value: string) {
    this.body = value;
    return this;
  }
}

describe("web security", () => {
  test("requires exact Basic credentials", () => {
    const key = "a-secure-master-key-that-is-long-enough";
    const valid = `Basic ${Buffer.from(`admin:${key}`).toString("base64")}`;
    expect(isAuthenticated(request({ authorization: valid }), key)).toBeTrue();
    expect(isAuthenticated(request({ authorization: valid }), "another-secure-master-key-long-enough")).toBeFalse();
  });

  test("accepts matching origins and rejects foreign requests", () => {
    expect(hasSameOrigin(request({ origin: "https://reset.vercel.app", "x-forwarded-proto": "https", "x-forwarded-host": "reset.vercel.app", "sec-fetch-site": "same-site" }))).toBeTrue();
    expect(hasSameOrigin(request({ origin: "https://attacker.example", "x-forwarded-proto": "https", "x-forwarded-host": "reset.vercel.app" }))).toBeFalse();
    expect(hasSameOrigin(request({ "sec-fetch-site": "cross-site" }))).toBeFalse();
  });

  test("renders a compact configured dashboard without trusting summary text", () => {
    const response = new ResponseStub();
    renderService(response as never, {
      configured: true,
      summary: {
        configured: true,
        availableCount: 3,
        nextExpiry: "2026-07-26T23:47:11.911Z",
        lastCheckAt: "2026-07-18T19:31:35.876Z",
        lastResult: "No credit is due <script>",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("status-dot");
    expect(response.body).toContain("Check every 5 min");
    expect(response.body).toContain('datetime="2026-07-26T23:47:11.911Z"');
    expect(response.body).toContain("No credit is due &lt;script&gt;");
    expect(response.body).not.toContain("No credit is due <script>");
  });
});

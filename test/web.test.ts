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
        availableCredits: [
          { expiresAt: "2026-07-26T23:47:11.911Z" },
          { expiresAt: "2026-08-02T23:47:11.911Z" },
          { expiresAt: "2026-08-09T23:47:11.911Z" },
        ],
        nextExpiry: "2026-07-26T23:47:11.911Z",
        lastCheckAt: "2026-07-18T19:31:35.876Z",
        lastResult: "No full reset is due <script>",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("status-dot");
    expect(response.body).toContain("Check every 5 min");
    expect(response.body).toContain("REDEEM_LEAD_MINUTES");
    expect(response.body).not.toContain("Encrypted storage");
    expect(response.body).toContain("Automatically redeems Codex resets before they expire.");
    expect(response.body).toContain('aria-label="Check now"');
    expect(response.body).toContain('data-open-dialog="disconnect-codex-dialog"');
    expect(response.body).toContain("You will need to connect again");
    expect(response.body).toContain("https://x.com/marc_krenn");
    expect(response.body).toContain("https://github.com/marckrenn/codex-auto-reset-vercel");
    expect(response.body).toContain('datetime="2026-07-26T23:47:11.911Z"');
    expect(response.body).toContain("Show all 3 full reset expiries");
    expect(response.body).toContain("Auto-redeems next");
    expect(response.body).toContain("Full reset 1");
    expect(response.body).toContain("Use reset");
    expect(response.body).toContain("Are you sure?");
    expect(response.body).toContain('action="/consume"');
    expect(response.body).toContain('datetime="2026-08-09T23:47:11.911Z"');
    expect(response.body).toContain("No full reset is due &lt;script&gt;");
    expect(response.body).not.toContain("No full reset is due <script>");
  });

  test("renders a copyable device code with a clean expiry line", () => {
    const response = new ResponseStub();
    renderService(response as never, {
      configured: false,
      deviceFlow: {
        userCode: "ABCD-EFGH",
        expiresAt: Date.parse("2026-07-19T00:19:00Z"),
        nextPollAt: 0,
        intervalMs: 5_000,
      },
      summary: { configured: false },
    });
    expect(response.body).toContain('id="device-code">ABCD-EFGH');
    expect(response.body).toContain('data-copy-target="device-code"');
    expect(response.body).toContain("Approval is checked automatically.");
    expect(response.body).not.toContain("This code expires");
  });

  test("hides routine check results until noteworthy activity occurs", () => {
    const response = new ResponseStub();
    renderService(response as never, {
      configured: true,
      summary: { configured: true, availableCount: 3, lastResult: "No full reset is due" },
    });
    expect(response.body).not.toContain("Recent activity");
    expect(response.body).not.toContain("No full reset is due");
  });
});

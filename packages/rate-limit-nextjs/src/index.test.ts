import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RateLimitStore } from "@lyrianapps/rate-limit";
import { withRateLimit, type WithRateLimitOptions } from "./index.js";

// ─── next/server mock ─────────────────────────────────────────────────────────
// `NextResponse` is used inside withRateLimit to build 429 responses.
// We mock it with the standard `Response` / `Headers` globals (Node 18+).

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init: ResponseInit = {}) =>
      new Response(JSON.stringify(body), {
        ...init,
        headers: { "content-type": "application/json", ...init.headers },
      }),
  },
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(
  headers: Record<string, string> = {},
): Parameters<typeof withRateLimit>[0] extends (r: infer R, ...a: unknown[]) => unknown
  ? R
  : never {
  return {
    headers: { get: (key: string) => headers[key] ?? null },
  } as never;
}

function makeStore(
  overrides: Partial<{ count: number; throws: boolean }> = {},
): RateLimitStore {
  const count = overrides.count ?? 1;
  return {
    increment: overrides.throws
      ? vi.fn().mockRejectedValue(new Error("store error"))
      : vi.fn().mockResolvedValue({ count, resetAt: Date.now() + 60_000 }),
  };
}

const okHandler = vi.fn().mockResolvedValue(
  new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  }),
);

// ─── withRateLimit ────────────────────────────────────────────────────────────

describe("withRateLimit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore the mock implementation after clearAllMocks resets it.
    okHandler.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  });

  // ── Happy path ──────────────────────────────────────────────────────────────

  it("calls the handler and returns its response when not rate limited", async () => {
    const store = makeStore({ count: 1 });
    const wrapped = withRateLimit(okHandler, { store, limit: 10, windowMs: 60_000 });
    const response = await wrapped(makeRequest({ "x-forwarded-for": "1.2.3.4" }));
    expect(okHandler).toHaveBeenCalledOnce();
    expect(response.status).toBe(200);
  });

  it("attaches X-RateLimit-* headers to allowed responses", async () => {
    const store = makeStore({ count: 3 });
    const wrapped = withRateLimit(okHandler, { store, limit: 10, windowMs: 60_000 });
    const response = await wrapped(makeRequest({ "x-forwarded-for": "1.2.3.4" }));
    expect(response.headers.get("X-RateLimit-Limit")).toBe("10");
    expect(response.headers.get("X-RateLimit-Remaining")).toBe("7");
    expect(response.headers.get("X-RateLimit-Reset")).toMatch(/^\d+$/);
  });

  // ── Rate limited ────────────────────────────────────────────────────────────

  it("returns 429 and does not call the handler when rate limited", async () => {
    const store = makeStore({ count: 11 });
    const wrapped = withRateLimit(okHandler, { store, limit: 10, windowMs: 60_000 });
    const response = await wrapped(makeRequest({ "x-forwarded-for": "1.2.3.4" }));
    expect(response.status).toBe(429);
    expect(okHandler).not.toHaveBeenCalled();
  });

  it("includes Retry-After and zeroed remaining on 429 response", async () => {
    const store = makeStore({ count: 100 });
    const wrapped = withRateLimit(okHandler, { store, limit: 10, windowMs: 60_000 });
    const response = await wrapped(makeRequest({ "x-forwarded-for": "1.2.3.4" }));
    expect(response.headers.get("X-RateLimit-Remaining")).toBe("0");
    const retryAfter = response.headers.get("Retry-After");
    expect(retryAfter).not.toBeNull();
    expect(Number(retryAfter)).toBeGreaterThan(0);
  });

  it("429 body contains an error message", async () => {
    const store = makeStore({ count: 11 });
    const wrapped = withRateLimit(okHandler, { store, limit: 10, windowMs: 60_000 });
    const response = await wrapped(makeRequest({ "x-forwarded-for": "1.2.3.4" }));
    const body = await response.json();
    expect(body).toHaveProperty("error");
  });

  // ── Key derivation ──────────────────────────────────────────────────────────

  it("defaults to x-forwarded-for as the rate-limit key", async () => {
    const store = makeStore();
    const wrapped = withRateLimit(okHandler, { store, limit: 10, windowMs: 60_000 });
    await wrapped(makeRequest({ "x-forwarded-for": "9.9.9.9" }));
    expect(store.increment).toHaveBeenCalledWith("9.9.9.9", 60_000);
  });

  it("falls back to x-real-ip when x-forwarded-for is absent", async () => {
    const store = makeStore();
    const wrapped = withRateLimit(okHandler, { store, limit: 10, windowMs: 60_000 });
    await wrapped(makeRequest({ "x-real-ip": "8.8.8.8" }));
    expect(store.increment).toHaveBeenCalledWith("8.8.8.8", 60_000);
  });

  it("falls back to 'unknown' when no IP header is present", async () => {
    const store = makeStore();
    const wrapped = withRateLimit(okHandler, { store, limit: 10, windowMs: 60_000 });
    await wrapped(makeRequest());
    expect(store.increment).toHaveBeenCalledWith("unknown", 60_000);
  });

  it("uses a custom keyFn when provided", async () => {
    const store = makeStore();
    const keyFn = vi.fn().mockReturnValue("user:42");
    const wrapped = withRateLimit(okHandler, {
      store,
      limit: 10,
      windowMs: 60_000,
      keyFn: keyFn as unknown as WithRateLimitOptions["keyFn"],
    });
    await wrapped(makeRequest());
    expect(store.increment).toHaveBeenCalledWith("user:42", 60_000);
  });

  // ── Options defaults ────────────────────────────────────────────────────────

  it("applies default limit (60) and windowMs (60 000) when not specified", async () => {
    const store = makeStore();
    const wrapped = withRateLimit(okHandler, { store });
    await wrapped(makeRequest({ "x-forwarded-for": "1.1.1.1" }));
    expect(store.increment).toHaveBeenCalledWith("1.1.1.1", 60_000);
    expect((store.increment as ReturnType<typeof vi.fn>).mock.calls[0]).toContain(60_000);
    const response = await withRateLimit(okHandler, { store })(makeRequest({ "x-forwarded-for": "2.2.2.2" }));
    expect(response.headers.get("X-RateLimit-Limit")).toBe("60");
  });

  // ── Error handling ──────────────────────────────────────────────────────────

  it("lets the request through (fail open) when the store throws and no onError is set", async () => {
    const store = makeStore({ throws: true });
    const wrapped = withRateLimit(okHandler, { store, limit: 10, windowMs: 60_000 });
    const response = await wrapped(makeRequest({ "x-forwarded-for": "1.2.3.4" }));
    expect(response.status).toBe(200);
    expect(okHandler).toHaveBeenCalledOnce();
  });

  it("returns 429 (fail closed) when the store throws and onError returns 'deny'", async () => {
    const store = makeStore({ throws: true });
    const wrapped = withRateLimit(okHandler, {
      store,
      limit: 10,
      windowMs: 60_000,
      onError: () => "deny",
    });
    const response = await wrapped(makeRequest({ "x-forwarded-for": "1.2.3.4" }));
    expect(response.status).toBe(429);
    expect(okHandler).not.toHaveBeenCalled();
  });

  // ── Route context forwarding ────────────────────────────────────────────────

  it("forwards the context argument to the handler", async () => {
    const store = makeStore();
    const wrapped = withRateLimit(okHandler, { store, limit: 10, windowMs: 60_000 });
    const ctx = { params: Promise.resolve({ id: "123" }) };
    await wrapped(makeRequest({ "x-forwarded-for": "1.2.3.4" }), ctx);
    expect(okHandler).toHaveBeenCalledWith(expect.anything(), ctx);
  });
});

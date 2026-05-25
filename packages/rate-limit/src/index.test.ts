import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import {
  MemoryStore,
  RedisStore,
  createRateLimiter,
  rateLimit,
  type RateLimitStore,
} from "./index.js";

// ─── MemoryStore ──────────────────────────────────────────────────────────────

describe("MemoryStore", () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore();
  });

  afterEach(async () => {
    await store.close();
  });

  it("starts count at 1 for a new key", async () => {
    const result = await store.increment("key1", 60_000);
    expect(result.count).toBe(1);
    expect(result.resetAt).toBeGreaterThan(Date.now());
  });

  it("increments the count for subsequent calls within the window", async () => {
    await store.increment("key1", 60_000);
    await store.increment("key1", 60_000);
    const result = await store.increment("key1", 60_000);
    expect(result.count).toBe(3);
  });

  it("preserves the original resetAt within a window", async () => {
    const first = await store.increment("key1", 60_000);
    const second = await store.increment("key1", 60_000);
    expect(second.resetAt).toBe(first.resetAt);
  });

  it("resets the counter after the window expires", async () => {
    vi.useFakeTimers();
    const first = await store.increment("key1", 100);
    expect(first.count).toBe(1);
    vi.advanceTimersByTime(200);
    const second = await store.increment("key1", 100);
    expect(second.count).toBe(1);
    vi.useRealTimers();
  });

  it("tracks separate keys independently", async () => {
    const r1 = await store.increment("key1", 60_000);
    const r2 = await store.increment("key2", 60_000);
    expect(r1.count).toBe(1);
    expect(r2.count).toBe(1);
  });

  it("close clears all stored counters", async () => {
    await store.increment("key1", 60_000);
    await store.close();
    // After close the internal map is cleared; a fresh increment starts at 1.
    const result = await store.increment("key1", 60_000);
    expect(result.count).toBe(1);
  });
});

// ─── RedisStore ───────────────────────────────────────────────────────────────

describe("RedisStore", () => {
  const mockRedis = {
    eval: vi.fn<() => Promise<[number, number]>>(),
    status: "ready",
    quit: vi.fn<() => Promise<string>>().mockResolvedValue("OK"),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls redis.eval with the lua script, 1 key, the key name, and windowMs", async () => {
    mockRedis.eval.mockResolvedValue([1, 59_000]);
    const store = new RedisStore(mockRedis);
    await store.increment("mykey", 60_000);
    expect(mockRedis.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      "mykey",
      60_000,
    );
  });

  it("returns the count from Redis", async () => {
    mockRedis.eval.mockResolvedValue([7, 30_000]);
    const store = new RedisStore(mockRedis);
    const result = await store.increment("mykey", 60_000);
    expect(result.count).toBe(7);
  });

  it("computes resetAt from pttl when pttl >= 0", async () => {
    mockRedis.eval.mockResolvedValue([1, 45_000]);
    const store = new RedisStore(mockRedis);
    const before = Date.now();
    const result = await store.increment("mykey", 60_000);
    const after = Date.now();
    expect(result.resetAt).toBeGreaterThanOrEqual(before + 45_000);
    expect(result.resetAt).toBeLessThanOrEqual(after + 45_000);
  });

  it("falls back to full windowMs when pttl is -1", async () => {
    mockRedis.eval.mockResolvedValue([1, -1]);
    const store = new RedisStore(mockRedis);
    const before = Date.now();
    const result = await store.increment("mykey", 60_000);
    const after = Date.now();
    expect(result.resetAt).toBeGreaterThanOrEqual(before + 60_000);
    expect(result.resetAt).toBeLessThanOrEqual(after + 60_000);
  });

  it("calls quit on close when status is not 'end'", async () => {
    const store = new RedisStore(mockRedis);
    await store.close();
    expect(mockRedis.quit).toHaveBeenCalledOnce();
  });

  it("skips quit on close when status is 'end'", async () => {
    const store = new RedisStore({ ...mockRedis, status: "end" });
    await store.close();
    expect(mockRedis.quit).not.toHaveBeenCalled();
  });
});

// ─── rateLimit ────────────────────────────────────────────────────────────────

describe("rateLimit", () => {
  let mockStore: { increment: MockInstance };

  beforeEach(() => {
    mockStore = { increment: vi.fn() };
  });

  it("returns limited=false and correct remaining when under the limit", async () => {
    mockStore.increment.mockResolvedValue({
      count: 5,
      resetAt: Date.now() + 60_000,
    });
    const result = await rateLimit(
      mockStore as unknown as RateLimitStore,
      "key",
      { limit: 10, windowMs: 60_000 },
    );
    expect(result.limited).toBe(false);
    expect(result.remaining).toBe(5);
    expect(result.count).toBe(5);
  });

  it("returns limited=false when count equals the limit", async () => {
    mockStore.increment.mockResolvedValue({
      count: 10,
      resetAt: Date.now() + 60_000,
    });
    const result = await rateLimit(
      mockStore as unknown as RateLimitStore,
      "key",
      { limit: 10, windowMs: 60_000 },
    );
    expect(result.limited).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it("returns limited=true when count exceeds the limit", async () => {
    mockStore.increment.mockResolvedValue({
      count: 11,
      resetAt: Date.now() + 60_000,
    });
    const result = await rateLimit(
      mockStore as unknown as RateLimitStore,
      "key",
      { limit: 10, windowMs: 60_000 },
    );
    expect(result.limited).toBe(true);
    expect(result.remaining).toBe(0);
  });

  it("remaining is never negative", async () => {
    mockStore.increment.mockResolvedValue({
      count: 999,
      resetAt: Date.now() + 60_000,
    });
    const result = await rateLimit(
      mockStore as unknown as RateLimitStore,
      "key",
      { limit: 10, windowMs: 60_000 },
    );
    expect(result.remaining).toBe(0);
  });

  it("resetAt is a Date instance", async () => {
    mockStore.increment.mockResolvedValue({
      count: 1,
      resetAt: Date.now() + 60_000,
    });
    const result = await rateLimit(
      mockStore as unknown as RateLimitStore,
      "key",
      { limit: 10, windowMs: 60_000 },
    );
    expect(result.resetAt).toBeInstanceOf(Date);
  });

  it("fails open by default when the store throws", async () => {
    mockStore.increment.mockRejectedValue(new Error("Redis down"));
    const result = await rateLimit(
      mockStore as unknown as RateLimitStore,
      "key",
      { limit: 10, windowMs: 60_000 },
    );
    expect(result.limited).toBe(false);
    expect(result.remaining).toBe(10);
    expect(result.count).toBe(0);
  });

  it("fails closed when onError returns 'deny'", async () => {
    mockStore.increment.mockRejectedValue(new Error("Redis down"));
    const result = await rateLimit(
      mockStore as unknown as RateLimitStore,
      "key",
      { limit: 10, windowMs: 60_000, onError: () => "deny" },
    );
    expect(result.limited).toBe(true);
    expect(result.remaining).toBe(0);
    expect(result.count).toBe(11);
  });

  it("calls onError with the thrown error", async () => {
    const err = new Error("boom");
    const onError = vi.fn<() => "allow">().mockReturnValue("allow");
    mockStore.increment.mockRejectedValue(err);
    await rateLimit(mockStore as unknown as RateLimitStore, "key", {
      limit: 10,
      windowMs: 60_000,
      onError,
    });
    expect(onError).toHaveBeenCalledWith(err);
  });
});

// ─── createRateLimiter ────────────────────────────────────────────────────────

describe("createRateLimiter", () => {
  it("returns a function that applies the bound config", async () => {
    const store = new MemoryStore();
    const limiter = createRateLimiter(store, { limit: 5, windowMs: 60_000 });
    const result = await limiter("test-key");
    expect(result.count).toBe(1);
    expect(result.limited).toBe(false);
    expect(result.remaining).toBe(4);
    await store.close();
  });

  it("accumulates counts across calls with the same key", async () => {
    const store = new MemoryStore();
    const limiter = createRateLimiter(store, { limit: 3, windowMs: 60_000 });
    await limiter("k");
    await limiter("k");
    const result = await limiter("k");
    expect(result.count).toBe(3);
    expect(result.limited).toBe(false);
    const overLimit = await limiter("k");
    expect(overLimit.limited).toBe(true);
    await store.close();
  });
});

// =============================================================================
// @lyrianappsdev/rate-limit
//
// Framework-agnostic rate limiting primitives. Zero runtime dependencies.
//
// Recommended ioredis client config for Cloud Run / serverless:
//   new Redis(process.env.REDIS_URL, {
//     lazyConnect: true,          // don't connect at module load (cold start)
//     enableOfflineQueue: false,  // fail fast instead of queuing on disconnect
//     connectTimeout: 2_000,
//     commandTimeout: 2_000,
//   })
//
// SIGTERM / graceful shutdown — add to your server entrypoint, not here:
//   process.once('SIGTERM', async () => {
//     await store.close();
//     process.exit(0);
//   });
// =============================================================================

// ─── Interfaces ───────────────────────────────────────────────────────────────

/**
 * Storage backend contract. Implement this to plug in any store.
 * Built-ins: MemoryStore (dev/single-instance), RedisStore (production).
 */
export interface RateLimitStore {
  /**
   * Atomically increment the counter for `key` within a `windowMs` window.
   * Returns the new count and the Unix ms timestamp when the window resets.
   */
  increment(
    key: string,
    windowMs: number,
  ): Promise<{ count: number; resetAt: number }>;
  /**
   * Graceful shutdown — close connections, clear timers.
   * Register in your SIGTERM handler; do NOT call at module load time.
   */
  close?(): Promise<void>;
}

export interface RateLimitConfig {
  /** Max requests allowed in the window. */
  limit: number;
  /** Window duration in milliseconds. */
  windowMs: number;
  /**
   * Called when the store throws (e.g. Redis unreachable).
   * Return 'allow' to fail open (let the request through, log the error).
   * Return 'deny'  to fail closed (treat as rate-limited, safe default).
   * Defaults to 'allow' — Cloud Run health checks will not fail on Redis blips.
   */
  onError?: (err: unknown) => "allow" | "deny";
}

export interface RateLimitResult {
  limited: boolean;
  remaining: number;
  resetAt: Date;
  count: number;
}

// ─── MemoryStore ──────────────────────────────────────────────────────────────
// ⚠️  DEV / SINGLE-INSTANCE ONLY.
//
// Reasons NOT to use in production:
//   1. State resets on every cold start — counters start at zero per instance.
//   2. Cloud Run can run N instances simultaneously; effective limit becomes
//      limit × N — completely unenforceable.
//   3. increment() is not atomic across concurrent requests in the same process
//      (JavaScript is single-threaded so in-process races are rare, but still).
//
// Use RedisStore for any multi-instance or serverless deployment.

export class MemoryStore implements RateLimitStore {
  private readonly store = new Map<
    string,
    { count: number; resetAt: number }
  >();
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(cleanupIntervalMs = 5 * 60 * 1000) {
    this.timer = setInterval(() => {
      const now = Date.now();
      for (const [key, record] of this.store) {
        if (now > record.resetAt) this.store.delete(key);
      }
    }, cleanupIntervalMs);
    // Allow the Node.js process / Cloud Run instance to exit cleanly.
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  async increment(
    key: string,
    windowMs: number,
  ): Promise<{ count: number; resetAt: number }> {
    const now = Date.now();
    const record = this.store.get(key);

    if (!record || now > record.resetAt) {
      const resetAt = now + windowMs;
      this.store.set(key, { count: 1, resetAt });
      return { count: 1, resetAt };
    }

    record.count++;
    return { count: record.count, resetAt: record.resetAt };
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    this.store.clear();
  }
}

// ─── RedisStore ───────────────────────────────────────────────────────────────
// Production store. Accepts any Redis client that satisfies RedisLike.
// ioredis.Redis satisfies this interface out of the box.
//
// The store does NOT own the connection — pass in a shared singleton so the
// same connection is reused across all limiters.
//
// Atomic fixed-window via Lua (INCR + PEXPIRE).
// INCR is atomic in Redis; PEXPIRE is set only on the first increment so the
// window start is stable. No race conditions under concurrent requests.

/**
 * Minimal Redis client interface. ioredis.Redis satisfies this.
 * Typed this way so the core package has zero ioredis dependency at compile time
 * (ioredis stays a peer dep / the caller's concern).
 */
export interface RedisLike {
  eval(
    script: string,
    numkeys: number,
    ...args: Array<string | number>
  ): Promise<unknown>;
  /** Used by close() to skip quit calls on already-closed connections. */
  status: string;
  quit(): Promise<string>;
}

// Atomic fixed-window: INCR the key; set PEXPIRE only on first write.
// Returns [count, pttl_ms_remaining].
const FIXED_WINDOW_LUA = `
local v = redis.call('INCR', KEYS[1])
if v == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local pttl = redis.call('PTTL', KEYS[1])
return {v, pttl}
`;

export class RedisStore implements RateLimitStore {
  constructor(private readonly redis: RedisLike) {}

  async increment(
    key: string,
    windowMs: number,
  ): Promise<{ count: number; resetAt: number }> {
    const result = (await this.redis.eval(
      FIXED_WINDOW_LUA,
      1,
      key,
      windowMs,
    )) as [number, number];

    const [count, pttl] = result;
    // pttl is -1 (no expiry set) only if the key existed before this call
    // with no TTL — treat as full window remaining in that edge case.
    const remaining = pttl >= 0 ? pttl : windowMs;
    return { count, resetAt: Date.now() + remaining };
  }

  /**
   * Gracefully close the Redis connection.
   * Wire this up in your SIGTERM handler to avoid ECONNRESET errors in logs:
   *
   *   process.once('SIGTERM', async () => { await store.close(); process.exit(0); });
   */
  async close(): Promise<void> {
    if (this.redis.status !== "end") {
      await this.redis.quit();
    }
  }
}

// ─── Core Functions ───────────────────────────────────────────────────────────

/**
 * Check rate limit for a given key against a store.
 * Handles store errors via the `onError` config callback.
 *
 * @example
 * const result = await rateLimit(store, `ip:${ip}`, { limit: 60, windowMs: 60_000 });
 * if (result.limited) return new Response("Too many requests", { status: 429 });
 *
 * // With explicit error handling:
 * const result = await rateLimit(store, key, {
 *   limit: 10,
 *   windowMs: 60_000,
 *   onError: (err) => { logger.error(err); return 'allow'; },
 * });
 */
export async function rateLimit(
  store: RateLimitStore,
  key: string,
  config: RateLimitConfig,
): Promise<RateLimitResult> {
  const { limit, windowMs, onError } = config;
  let count: number;
  let resetAt: number;

  try {
    ({ count, resetAt } = await store.increment(key, windowMs));
  } catch (err) {
    // Default: fail open — let the request through, log externally via onError.
    const behavior = onError?.(err) ?? "allow";
    const fallbackReset = Date.now() + windowMs;
    if (behavior === "deny") {
      return {
        limited: true,
        remaining: 0,
        resetAt: new Date(fallbackReset),
        count: limit + 1,
      };
    }
    return {
      limited: false,
      remaining: limit,
      resetAt: new Date(fallbackReset),
      count: 0,
    };
  }

  return {
    limited: count > limit,
    remaining: Math.max(0, limit - count),
    resetAt: new Date(resetAt),
    count,
  };
}

/**
 * Create a pre-configured limiter bound to a store and config.
 * Returns a function that only requires a key — define once, call anywhere.
 *
 * @example
 * const authLimiter = createRateLimiter(redisStore, { limit: 10, windowMs: 60_000 });
 * const result = await authLimiter(`login:${ip}`);
 */
export function createRateLimiter(
  store: RateLimitStore,
  config: RateLimitConfig,
) {
  return (key: string): Promise<RateLimitResult> =>
    rateLimit(store, key, config);
}

// ─── Preset limiters ──────────────────────────────────────────────────────────
// ⚠️  Uses MemoryStore — DEVELOPMENT ONLY.
// In production, replace _defaultStore with a shared RedisStore singleton
// (same pattern as lib/prisma.ts — module-level singleton, lazyConnect).
//
// Key namespacing: each preset uses a unique prefix so limiters can't
// interfere with each other even when sharing a store (e.g. `api:` vs `auth:`).

/** @internal Exported so @lyrianappsdev/rate-limit-nextjs can share this instance as a default. */
export const _defaultStore = new MemoryStore();

export const rateLimiters = {
  api: (ip: string) =>
    rateLimit(_defaultStore, `api:${ip}`, { limit: 60, windowMs: 60_000 }),
  auth: (ip: string) =>
    rateLimit(_defaultStore, `auth:${ip}`, { limit: 10, windowMs: 60_000 }),
  expensive: (userId: string) =>
    rateLimit(_defaultStore, `expensive:${userId}`, {
      limit: 5,
      windowMs: 60_000,
    }),
};

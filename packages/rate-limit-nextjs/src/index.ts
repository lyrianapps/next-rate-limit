// =============================================================================
// @lyrianappsdev/rate-limit-nextjs
//
// Next.js App Router adapter for @lyrianappsdev/rate-limit.
// Peer dependencies: next >= 14, @lyrianappsdev/rate-limit
// =============================================================================

import { NextRequest, NextResponse } from "next/server";
import {
  type RateLimitConfig,
  type RateLimitStore,
  MemoryStore,
  rateLimit,
} from "@lyrianappsdev/rate-limit";

// Re-export core primitives so consumers only need one import.
export type {
  RateLimitConfig,
  RateLimitResult,
  RateLimitStore,
} from "@lyrianappsdev/rate-limit";
export {
  MemoryStore,
  RedisStore,
  rateLimit,
  createRateLimiter,
  rateLimiters,
} from "@lyrianappsdev/rate-limit";

// ─── Types ────────────────────────────────────────────────────────────────────

type RouteHandler = (
  request: NextRequest,
  context?: { params?: Promise<Record<string, string>> },
) => Promise<NextResponse | Response> | NextResponse | Response;

export interface WithRateLimitOptions extends Partial<RateLimitConfig> {
  /** Storage backend. Defaults to an in-process MemoryStore (dev only). */
  store?: RateLimitStore;
  /** Derive a rate-limit key from the request. Defaults to IP address. */
  keyFn?: (request: NextRequest) => string;
  /**
   * Called when the store throws. Mirrors RateLimitConfig.onError.
   * 'allow' (default) — pass the request through and log externally.
   * 'deny'            — return 429, safe for strict environments.
   */
  onError?: (err: unknown) => "allow" | "deny";
}

// ─── Default store ────────────────────────────────────────────────────────────
// ⚠️  DEV / SINGLE-INSTANCE ONLY — replace with a shared RedisStore singleton
// in production (same pattern as lib/prisma.ts — module-level, lazyConnect).

const _defaultStore = new MemoryStore();

// ─── withRateLimit ────────────────────────────────────────────────────────────

/**
 * Middleware wrapper that adds rate limiting to any Next.js App Router route.
 * Attaches standard `X-RateLimit-*` headers to every response.
 *
 * @example
 * // app/api/hello/route.ts
 * export const GET = withRateLimit(async (request) => {
 *   return NextResponse.json({ data: "hello" });
 * });
 *
 * // Custom store + stricter limit:
 * export const POST = withRateLimit(handler, {
 *   store: redisStore,
 *   limit: 10,
 *   windowMs: 60_000,
 * });
 */
export function withRateLimit(
  handler: RouteHandler,
  options: WithRateLimitOptions = {},
): RouteHandler {
  const {
    store = _defaultStore,
    limit = 60,
    windowMs = 60_000,
    onError,
    keyFn = (req) =>
      req.headers.get("x-forwarded-for") ??
      req.headers.get("x-real-ip") ??
      "unknown",
  } = options;

  return async (request, context) => {
    const key = keyFn(request);
    const result = await rateLimit(store, key, {
      limit,
      windowMs,
      ...(onError !== undefined && { onError }),
    });

    const rlHeaders = {
      "X-RateLimit-Limit": String(limit),
      "X-RateLimit-Remaining": String(result.remaining),
      "X-RateLimit-Reset": String(Math.floor(result.resetAt.getTime() / 1000)),
    };

    if (result.limited) {
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        {
          status: 429,
          headers: {
            ...rlHeaders,
            "X-RateLimit-Remaining": "0",
            "Retry-After": String(
              Math.ceil((result.resetAt.getTime() - Date.now()) / 1000),
            ),
          },
        },
      );
    }

    const response = await handler(request, context);

    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(rlHeaders)) headers.set(k, v);

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}

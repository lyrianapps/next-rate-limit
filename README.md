# `@lyrianapps/rate-limit` + `@lyrianapps/rate-limit-nextjs`

Fixed-window rate limiting for Next.js App Router. Two packages:

| Package | Purpose |
|---|---|
| `@lyrianapps/rate-limit` | Framework-agnostic core. Zero runtime dependencies. |
| `@lyrianapps/rate-limit-nextjs` | Next.js App Router adapter. Re-exports everything from core. |

---

## Installation

```bash
# In your Next.js app — just install the adapter (it re-exports the core)
npm install @lyrianapps/rate-limit-nextjs

# For production Redis support, add ioredis as well
npm install ioredis
```

---

## Quick start

### Wrap a route handler

```ts
// app/api/hello/route.ts
import { withRateLimit } from "@lyrianapps/rate-limit-nextjs";
import { NextResponse } from "next/server";

export const GET = withRateLimit(async (request) => {
  return NextResponse.json({ message: "hello" });
});
```

Defaults: **60 requests per 60 seconds**, keyed by `x-forwarded-for` / `x-real-ip`. Every response gets `X-RateLimit-*` headers. Exceeded requests get a `429` with a `Retry-After` header.

---

## Stores

### `MemoryStore` — development only

```ts
import { MemoryStore } from "@lyrianapps/rate-limit-nextjs";

const store = new MemoryStore();
```

> **⚠️ Do not use in production.** State resets on every cold start and is not shared across Cloud Run / serverless instances. The effective limit becomes `limit × N instances`.

### `RedisStore` — production

```ts
// lib/rate-limit-store.ts  (Next.js singleton pattern)
import Redis from "ioredis";
import { RedisStore } from "@lyrianapps/rate-limit-nextjs";

const redis = new Redis(process.env.REDIS_URL!, {
  lazyConnect: true,         // don't connect at module load (cold start)
  enableOfflineQueue: false, // fail fast instead of queuing on disconnect
  connectTimeout: 2_000,
  commandTimeout: 2_000,
});

export const store = new RedisStore(redis);
```

```ts
// app/api/hello/route.ts
import { withRateLimit } from "@lyrianapps/rate-limit-nextjs";
import { store } from "@/lib/rate-limit-store";
import { NextResponse } from "next/server";

export const POST = withRateLimit(
  async (request) => {
    return NextResponse.json({ message: "ok" });
  },
  { store, limit: 20, windowMs: 60_000 },
);
```

**SIGTERM / graceful shutdown** — add to your server entrypoint, not in route files:

```ts
process.once("SIGTERM", async () => {
  await store.close();
  process.exit(0);
});
```

---

## `withRateLimit` options

```ts
withRateLimit(handler, options?)
```

| Option | Type | Default | Description |
|---|---|---|---|
| `store` | `RateLimitStore` | `MemoryStore` | Storage backend |
| `limit` | `number` | `60` | Max requests per window |
| `windowMs` | `number` | `60_000` | Window size in milliseconds |
| `keyFn` | `(req: NextRequest) => string` | IP address | Key derivation function |
| `onError` | `(err: unknown) => 'allow' \| 'deny'` | `() => 'allow'` | Store error handler |

### Custom key — rate limit by user ID

```ts
export const POST = withRateLimit(handler, {
  store,
  limit: 10,
  windowMs: 60_000,
  keyFn: (req) => {
    // pull userId from a verified JWT/session header
    return req.headers.get("x-user-id") ?? req.headers.get("x-forwarded-for") ?? "unknown";
  },
});
```

### Error handling — fail open vs fail closed

```ts
export const POST = withRateLimit(handler, {
  store,
  onError: (err) => {
    console.error("[rate-limit] store error:", err);
    return "allow"; // let the request through when Redis is down
    // return "deny"; // return 429 when Redis is down (strict mode)
  },
});
```

---

## Using the core directly (framework-agnostic)

```ts
import { rateLimit, RedisStore, createRateLimiter } from "@lyrianapps/rate-limit";

// One-off check
const result = await rateLimit(store, `ip:${ip}`, { limit: 60, windowMs: 60_000 });

if (result.limited) {
  return new Response("Too many requests", { status: 429 });
}

// Pre-configured limiter — define once, call anywhere
const authLimiter = createRateLimiter(store, { limit: 10, windowMs: 60_000 });
const result = await authLimiter(`login:${ip}`);
```

### `RateLimitResult`

```ts
interface RateLimitResult {
  limited: boolean;   // true if the request should be blocked
  remaining: number;  // requests left in the current window
  resetAt: Date;      // when the window resets
  count: number;      // total requests seen in this window
}
```

---

## Preset limiters

A convenience object of pre-configured limiters backed by a shared `MemoryStore`. **Development only.**

```ts
import { rateLimiters } from "@lyrianapps/rate-limit-nextjs";

const result = await rateLimiters.api(ip);      // 60 req / 60s
const result = await rateLimiters.auth(ip);     // 10 req / 60s
const result = await rateLimiters.expensive(userId); // 5 req / 60s
```

Replace with a `RedisStore`-backed `createRateLimiter` in production.

---

## Response headers

Every response from `withRateLimit` includes:

| Header | Description |
|---|---|
| `X-RateLimit-Limit` | Max requests allowed |
| `X-RateLimit-Remaining` | Requests left in the window |
| `X-RateLimit-Reset` | Unix timestamp (seconds) when the window resets |
| `Retry-After` | Seconds to wait (only on `429` responses) |

---

## Implementing a custom store

```ts
import type { RateLimitStore } from "@lyrianapps/rate-limit";

export class MyCustomStore implements RateLimitStore {
  async increment(key: string, windowMs: number) {
    // atomically increment and return { count, resetAt }
    return { count: 1, resetAt: Date.now() + windowMs };
  }

  async close() {
    // clean up connections / timers
  }
}
```
# next-rate-limit

# @lyrianapps/rate-limit

Fixed-window rate limiting for Next.js App Router, built as two publishable packages:

- **`@lyrianapps/rate-limit`** — framework-agnostic core, zero runtime dependencies
- **`@lyrianapps/rate-limit-nextjs`** — Next.js App Router adapter, re-exports everything from core

## Installation

```bash
npm install @lyrianapps/rate-limit-nextjs
# Production Redis support
npm install ioredis
```

## Quick start

```ts
// app/api/hello/route.ts
import { withRateLimit } from "@lyrianapps/rate-limit-nextjs";
import { NextResponse } from "next/server";

export const GET = withRateLimit(async (request) => {
  return NextResponse.json({ message: "hello" });
});
```

Defaults to **60 req / 60 s**, keyed by IP. All responses include `X-RateLimit-*` headers. Exceeded requests return `429` with a `Retry-After` header.

## Stores

### MemoryStore — development only

```ts
import { MemoryStore } from "@lyrianapps/rate-limit-nextjs";
const store = new MemoryStore();
```

> **⚠️ Not for production.** State is not shared across instances — the effective limit becomes `limit × N instances`.

### RedisStore — production

```ts
// lib/rate-limit-store.ts
import Redis from "ioredis";
import { RedisStore } from "@lyrianapps/rate-limit-nextjs";

const redis = new Redis(process.env.REDIS_URL!, {
  lazyConnect: true,
  enableOfflineQueue: false,
  connectTimeout: 2_000,
  commandTimeout: 2_000,
});

export const store = new RedisStore(redis);
```

```ts
// app/api/hello/route.ts
import { withRateLimit } from "@lyrianapps/rate-limit-nextjs";
import { store } from "@/lib/rate-limit-store";

export const POST = withRateLimit(handler, { store, limit: 20, windowMs: 60_000 });
```

Add to your server entrypoint for graceful shutdown:

```ts
process.once("SIGTERM", async () => { await store.close(); process.exit(0); });
```

## `withRateLimit` options

| Option     | Type                                  | Default       | Description             |
| ---------- | ------------------------------------- | ------------- | ----------------------- |
| `store`    | `RateLimitStore`                      | `MemoryStore` | Storage backend         |
| `limit`    | `number`                              | `60`          | Max requests per window |
| `windowMs` | `number`                              | `60_000`      | Window duration in ms   |
| `keyFn`    | `(req: NextRequest) => string`        | IP address    | Key derivation          |
| `onError`  | `(err: unknown) => 'allow' \| 'deny'` | `'allow'`     | Store error behaviour   |

**Custom key:**

```ts
export const POST = withRateLimit(handler, {
  store,
  keyFn: (req) => req.headers.get("x-user-id") ?? "unknown",
});
```

**Fail closed on Redis errors:**

```ts
export const POST = withRateLimit(handler, {
  store,
  onError: (err) => { console.error(err); return "deny"; },
});
```

## Core API (framework-agnostic)

```ts
import { rateLimit, createRateLimiter } from "@lyrianapps/rate-limit";

// One-off check
const result = await rateLimit(store, `ip:${ip}`, { limit: 60, windowMs: 60_000 });
if (result.limited) return new Response("Too many requests", { status: 429 });

// Reusable limiter
const authLimiter = createRateLimiter(store, { limit: 10, windowMs: 60_000 });
const result = await authLimiter(`login:${ip}`);
```

`RateLimitResult`:

| Field       | Type      | Description                           |
| ----------- | --------- | ------------------------------------- |
| `limited`   | `boolean` | Whether the request should be blocked |
| `remaining` | `number`  | Requests left in the window           |
| `resetAt`   | `Date`    | When the window resets                |
| `count`     | `number`  | Total requests in this window         |

## Response headers

| Header                  | Description                            |
| ----------------------- | -------------------------------------- |
| `X-RateLimit-Limit`     | Max requests allowed                   |
| `X-RateLimit-Remaining` | Requests left                          |
| `X-RateLimit-Reset`     | Unix timestamp (s) of window reset     |
| `Retry-After`           | Seconds to wait — `429` responses only |

## Custom store

```ts
import type { RateLimitStore } from "@lyrianapps/rate-limit";

class MyStore implements RateLimitStore {
  async increment(key: string, windowMs: number) {
    return { count: 1, resetAt: Date.now() + windowMs };
  }
  async close() {}
}
```

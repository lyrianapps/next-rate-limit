# @lyrianappsdev/rate-limit

[![npm](https://img.shields.io/npm/v/@lyrianappsdev/rate-limit)](https://www.npmjs.com/package/@lyrianappsdev/rate-limit)

Framework-agnostic fixed-window rate limiting primitives. Zero runtime dependencies.

Part of the `@lyrianappsdev` rate limiting suite — see [`@lyrianappsdev/rate-limit-nextjs`](https://www.npmjs.com/package/@lyrianappsdev/rate-limit-nextjs) for the Next.js App Router adapter.

## Installation

```bash
npm install @lyrianappsdev/rate-limit
# Production Redis support
npm install ioredis
```

## Usage

```ts
import { rateLimit, RedisStore, createRateLimiter } from "@lyrianappsdev/rate-limit";

// One-off check
const result = await rateLimit(store, `ip:${ip}`, { limit: 60, windowMs: 60_000 });
if (result.limited) return new Response("Too many requests", { status: 429 });

// Reusable limiter — define once, call anywhere
const authLimiter = createRateLimiter(store, { limit: 10, windowMs: 60_000 });
const result = await authLimiter(`login:${ip}`);
```

## Stores

### MemoryStore — development only

```ts
import { MemoryStore } from "@lyrianappsdev/rate-limit";
const store = new MemoryStore();
```

> **⚠️ Not for production.** State resets on every cold start and is not shared across instances.

### RedisStore — production

Accepts any client that satisfies the `RedisLike` interface. `ioredis` works out of the box.

```ts
import Redis from "ioredis";
import { RedisStore } from "@lyrianappsdev/rate-limit";

const redis = new Redis(process.env.REDIS_URL!, {
  lazyConnect: true,
  enableOfflineQueue: false,
  connectTimeout: 2_000,
  commandTimeout: 2_000,
});

export const store = new RedisStore(redis);
```

Add to your server entrypoint for graceful shutdown:

```ts
process.once("SIGTERM", async () => { await store.close(); process.exit(0); });
```

## `rateLimit` config

| Option     | Type                                  | Description                                              |
| ---------- | ------------------------------------- | -------------------------------------------------------- |
| `limit`    | `number`                              | Max requests allowed in the window                       |
| `windowMs` | `number`                              | Window duration in milliseconds                          |
| `onError`  | `(err: unknown) => 'allow' \| 'deny'` | Store error behaviour. Defaults to `'allow'` (fail open) |

## `RateLimitResult`

| Field       | Type      | Description                           |
| ----------- | --------- | ------------------------------------- |
| `limited`   | `boolean` | Whether the request should be blocked |
| `remaining` | `number`  | Requests left in the window           |
| `resetAt`   | `Date`    | When the window resets                |
| `count`     | `number`  | Total requests in this window         |

## Custom store

```ts
import type { RateLimitStore } from "@lyrianappsdev/rate-limit";

class MyStore implements RateLimitStore {
  async increment(key: string, windowMs: number) {
    return { count: 1, resetAt: Date.now() + windowMs };
  }
  async close() {}
}
```

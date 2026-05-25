# @lyrianappsdev/rate-limit-nextjs

[![npm](https://img.shields.io/npm/v/@lyrianappsdev/rate-limit-nextjs)](https://www.npmjs.com/package/@lyrianappsdev/rate-limit-nextjs)

Next.js App Router adapter for [`@lyrianappsdev/rate-limit`](https://www.npmjs.com/package/@lyrianappsdev/rate-limit). Re-exports everything from core so you only need one import.

## Installation

```bash
npm install @lyrianappsdev/rate-limit-nextjs
# Production Redis support
npm install ioredis
```

## Quick start

```ts
// app/api/hello/route.ts
import { withRateLimit } from "@lyrianappsdev/rate-limit-nextjs";
import { NextResponse } from "next/server";

export const GET = withRateLimit(async (request) => {
  return NextResponse.json({ message: "hello" });
});
```

Defaults to **60 req / 60 s**, keyed by IP (`x-forwarded-for` / `x-real-ip`). All responses include `X-RateLimit-*` headers. Exceeded requests return `429` with a `Retry-After` header.

## Stores

### MemoryStore — development only

```ts
import { MemoryStore } from "@lyrianappsdev/rate-limit-nextjs";
const store = new MemoryStore();
```

> **⚠️ Not for production.** State is not shared across instances — the effective limit becomes `limit × N instances`.

### RedisStore — production

```ts
// lib/rate-limit-store.ts
import Redis from "ioredis";
import { RedisStore } from "@lyrianappsdev/rate-limit-nextjs";

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
import { withRateLimit } from "@lyrianappsdev/rate-limit-nextjs";
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

**Custom key — rate limit by user ID:**

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

## Response headers

| Header                  | Description                            |
| ----------------------- | -------------------------------------- |
| `X-RateLimit-Limit`     | Max requests allowed                   |
| `X-RateLimit-Remaining` | Requests left in the window            |
| `X-RateLimit-Reset`     | Unix timestamp (s) of window reset     |
| `Retry-After`           | Seconds to wait — `429` responses only |

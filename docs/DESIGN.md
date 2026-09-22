# Design doc (Phase 1)

## Problem
Turn one published blog post into a multi-platform campaign and publish it reliably: right image and caption per platform, a human approval step, scheduled publishing that survives crashes, never a duplicate post, respects rate limits, and reports delivery status only on verified evidence.

## Which brief, and why
Two versions of the capstone exist. I compared them on what they force you to engineer:

| | Multi-Platform Social Campaign Publisher (older) | Social Media Studio (newer) |
|---|---|---|
| Idempotency | key + timeout-after-accept + retries | key per variant/slot |
| Rate limits | `429` + `Retry-After` + backoff is a graded probe | not required |
| Auth / secrets | OAuth flow, tokens AES-GCM at rest, "no plaintext in DB/logs" probe | `.env` only |
| Trust boundary | HMAC-signed webhooks, forgery → 400, replay protection | none |
| Scheduling | durable + crash mid-batch | durable + crash mid-batch |
| Content | image variants (dimensions, safe zone) + captions | text variants, constraint profiles, review workflow |
| Real integration | none (sandbox only) | one real free platform |
| Missing pieces | fake server (must be written) | none |

The older brief covers a strict superset of the distributed-systems skills (rate limiting, webhook trust, secret custody) and its acceptance probes are the harder ones, so I built it. The organisers accept it provided the fake server is replaced; I wrote that server. From the newer brief I took the parts that add rigour without scope creep: **constraint profiles enforced in code**, the **review workflow**, and **publish history**. Left out on purpose: a real Telegram/Discord/Mastodon adapter and URL ingestion (see README limitations).

## Data model (SQLite, migrations in `src/db/migrations`)
`posts` → `campaigns` → `variants` (per platform: caption, image path/size, `review_status` draft|approved|rejected|blocked, validation errors) → `social_posts` (**the SocialPostEntry-shaped record and the durable job**: status queued|publishing|published|failed, idempotency key, scheduled/next-attempt time, attempts, lease owner/expiry, platform post id/url, last error). Support tables: `publish_attempts` (history), `oauth_tokens` (ciphertext only), `platform_limits` (rate-limit pauses), `webhook_events` (de-dup), `settings` (virtual clock offset).

Key constraints: `UNIQUE(variant_id)` and `UNIQUE(idempotency_key)` on `social_posts` make a duplicate job impossible at the database level.

## Publisher interface
```js
class SocialPublisher {
  get platform()                 // "instagram" | "x" | "linkedin"
  async publish({ idempotencyKey, caption, imagePath, link })
      // -> { platformPostId, url, replayed }
      // rejects with PublishError{ kind: rate_limited(+retryAfterMs) | timeout | transient | permanent }
}
```
Adapters translate HTTP into `PublishError`; the retry policy lives once in the worker. Adapters never retry publishing themselves (retries must be durable); the only exception is a one-shot OAuth refresh on `401`.

## State machine
```
variant.review_status:  draft ─approve→ approved      draft|blocked ─reject→ rejected      (blocked: violates a constraint profile)
social_post.status:     queued ─claim→ publishing ─webhook→ published | failed
                        publishing ─timeout/5xx/429→ queued (backoff / Retry-After)         (worker: retries exhausted → failed)
```

## API surface
See README. Validation at the boundary with zod → clean `4xx`; domain rules (`409 variant_not_approved`, `422 constraint_violation`) in services.

## Failure analysis (what the design must survive)
| Failure | Outcome |
|---|---|
| Client hammers publish | one row per variant; repeats return it |
| Platform accepted, response lost (timeout) | retry with the same key → platform replays the original |
| Worker killed after accept, before saving | lease expires → reclaimed → same key → replay |
| Two workers | atomic claim; fenced writes |
| `429 Retry-After` | platform paused for all jobs; retry after the window; attempt not consumed |
| Token expired/revoked | one refresh, same key |
| Forged / modified / replayed webhook | `400`, state untouched |
| Duplicate / out-of-order webhook | de-duplicated; terminal states final |

## Non-goals
Real social accounts, analytics/engagement, multi-tenant isolation, a webhook reconciliation poller, horizontal scale beyond one SQLite file.

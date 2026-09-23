# Social Media Studio

**Designed and developed by [Peter Maged](https://petermaged.com/).**

Create, review and schedule platform-specific campaigns with a durable publishing queue and signed delivery updates.

## Product and technical overview

- **Implementation:** Node.js 24, Express 4, SQLite, Sharp, OAuth adapters, HMAC webhooks.
- **Deployment:** Vercel frontend with an external backend; [DEPLOYMENT.md](DEPLOYMENT.md) contains exact settings and operational requirements.
- **Ownership:** Peter Maged's project implementation; third-party libraries and upstream materials retain their attribution.
- **License:** [LICENSE](LICENSE). Available for portfolio review, evaluation and further development under these terms.

For project enquiries and implementation work: [petermaged.com](https://petermaged.com/).

## Engineering guide and existing evidence

# flyrank-capstone-social-studio

**Multi-Platform Social Campaign Publisher** — turn one blog post into a campaign: a platform-correct image and a platform-specific caption per network, human approval, then durable, idempotent, rate-limit-aware publishing with status that only changes on a **signature-verified webhook**.

Everything runs locally against a **fake social platform server** (`fakeplatform/`) that simulates OAuth, rate limits (`429` + `Retry-After`), idempotency keys, random failures, "accepted but the response never arrived" timeouts, and HMAC-signed delivery webhooks. **No real account is ever touched. $0, no credit card.**

> **Which brief is this?** FlyRank published two versions of this capstone. This repo builds the older *Multi-Platform Social Campaign Publisher* because it has the deeper reliability surface (signed webhooks, OAuth + encrypted tokens, 429 handling, crash-safe scheduling). The organisers confirmed that version is still accepted as long as the missing `starters/challenge-5-social/` server is replaced, so `fakeplatform/server.js` is that replacement (written from scratch, ~350 lines). The strongest ideas from the newer *Social Media Studio* brief are included too: **constraint profiles enforced by code**, a **draft → approved | rejected review workflow**, and a visible **publish history**. See [docs/DESIGN.md](docs/DESIGN.md) for the comparison and what is deliberately *not* included.

## Architecture

```
 Blog post (title, body, url)                      stored once = single source of truth
        │
        ├─► Caption composer ── brandVoice + platform rules + content summary ──► caption per platform
        │        └─► constraint validation (length, hashtags, links, tone)  ── violation => 'blocked' / 422
        └─► Image pipeline (sharp) ── subject-aware crop + safe zone ──────────► 1080² · 1600×900 · 1200×627
                                   │
                          variants: draft ──approve──► approved   (reject / blocked never publish)
                                   │
              schedule / publish ──┴─► social_posts row  (UNIQUE per variant, idempotency key fixed)
                                                 │  durable queue in SQLite (survives crashes)
        ┌────────────────────────────────────────▼─────────────────────────────────────────┐
        │ PublishWorker  claim(lease) ─► SocialPublisher.publish(idempotencyKey) ─► markAccepted │
        │   429 → pause platform until Retry-After   timeout/5xx → backoff+jitter, SAME key    │
        └───────────────────────────────┬──────────────────────────────────────────────────┘
                                        │ interface only: FakeInstagram · FakeX · FakeLinkedIn adapters
                                        ▼
                    FAKE PLATFORM  ── OAuth token · Idempotency-Key · 429 · faults
                                        │  async, HMAC-signed delivery webhook (at-least-once)
                                        ▼
   POST /webhook/social-delivery ─► verify HMAC over raw body + timestamp window
                                        ├─ invalid / forged / modified / replayed → 400, nothing changes
                                        └─ valid → status: queued → publishing → published | failed
```

Layers (`src/`): `http/` (validation + routing only) → `services/` (business rules) → `db/repos.js` (the only SQL) · `adapters/` (the only platform-specific code) · `content/` (pure functions) · `lib/` (crypto, signature, retry, logger, clock).

## Run it (Node ≥ 22.13, one command)

```bash
cp .env.example .env        # then fill the four secrets (commands are in the file's comments)
npm install
npm start                   # fake platform :4010  +  app & worker :3100
npm run seed                # in a second terminal: demo posts + one draft campaign
```

Open <http://localhost:3100>, paste your `API_KEY` when asked. Or run the scripted walkthrough of the demo flow:

```bash
npm run demo
```

Docker alternative: `docker compose up` (reads the same `.env`).

Tests (no servers needed, they boot their own): `npm test` → 82 tests, ~30 s.

### Demo flow (brief §13) and where to see each moment

| Moment | How |
|---|---|
| Create campaign, generated images, different captions | dashboard **Create campaign**, or `npm run demo` steps 1–2 |
| Schedule "tomorrow 09:00", advance time, worker publishes | **Schedule**, then **+1 day** (virtual scheduler clock, shared by web and worker) |
| Hammer publish → one post | click **Publish now** repeatedly / `demo` step 4 (5 parallel calls, 1 creates, 4 replay) |
| 429 Retry-After handled calmly | `POST :4010/_admin/rate-limit {"retryAfter":3,"platform":"x"}` then publish |
| Forged webhook 400, valid one flips status | `demo` step 6 (uses `POST :4010/_admin/webhooks/hold` so the platform stays silent) |
| Kill worker mid-batch | `WORKER_IN_PROCESS=false npm run app`, `npm run worker`, kill it, start it again |

## API (all `/api/*` need `Authorization: Bearer $API_KEY`)

| Method & path | Purpose |
|---|---|
| `POST /api/posts` `{title, body, url}` | ingest a post (validated; `400` on bad input) |
| `POST /api/posts/:id/campaigns` `{platforms?, captions?}` | generate variants; a hand-written caption that breaks a rule → `422` naming the rule |
| `GET /api/campaigns[/:id]` | campaign with variants and their delivery entries (the status table) |
| `PATCH /api/variants/:id` `{caption}` | edit (re-validated) |
| `POST /api/variants/:id/approve \| reject` | review workflow |
| `POST /api/campaigns/:id/schedule` `{at \| inSeconds, platforms?}` | schedule; unapproved variant → `409 variant_not_approved`, nothing scheduled |
| `POST /api/campaigns/:id/publish` | schedule for now; repeating it is a no-op (`200`, `replayed:true`) |
| `GET /api/campaigns/:id/history`, `GET /api/history` | every publish attempt and its outcome |
| `POST /webhook/social-delivery` | signature-authenticated delivery events (no API key) |
| `/api/admin/*` | virtual clock + manual worker tick; only when `ENABLE_DEMO_CONTROLS=true` |

## How each hard requirement is met

* **Idempotency** — three independent layers: the schedule call returns the existing entry; the database has `UNIQUE(variant_id)` and `UNIQUE(idempotency_key)`; and every attempt sends the *same* `Idempotency-Key` (`studio-variant-<id>`, never derived from time or attempt number), so a retry after a lost response replays the original post instead of creating a second.
* **Durable scheduling** — the queue *is* the `social_posts` table. Workers claim rows with one atomic `UPDATE … RETURNING` that sets a lease; a dead worker's lease expires and the row is reclaimed. All worker writes are fenced by `locked_by`, so a zombie cannot overwrite the new owner. Tested with real `SIGKILL`ed worker processes.
* **Rate limits** — `429` → parse `Retry-After` (seconds *or* HTTP-date), pause that *platform* for every job/worker (`platform_limits`), retry once allowed, don't spend the retry budget. Other platforms keep flowing. Other failures use exponential backoff with jitter and a bounded attempt budget.
* **Trust boundary** — `published` is only ever set by the webhook handler: HMAC-SHA256 over `timestamp.rawBody`, constant-time compare, 5-minute replay window, event-id de-duplication, terminal states never overwritten.
* **Secrets** — OAuth tokens are stored only as AES-256-GCM ciphertext (fresh random 96-bit IV per write, AAD = platform); the logger redacts by key name *and* by literal value; the tests grep the raw DB/WAL bytes and captured logs for every secret.
* **Adapter seam** — the app depends on `SocialPublisher` (`src/adapters/SocialPublisher.js`); only `adapters/index.js` names concrete classes.

## Configuration

See [.env.example](.env.example); every variable is documented there. Secrets live only in `.env` (git-ignored).

## Limitations (honest list)

* Fake platform only; no real-platform adapter (Telegram/Discord/Mastodon from the newer brief is **not** implemented).
* `SocialPostEntry` (FlyRank's internal type) was not provided, so the record shape in `social_posts` is my own reading of "status + ids + timestamps".
* If a platform accepts a post but its webhook **never** arrives, the entry stays `publishing` (there is no reconciliation poller). By design a post is never *guessed* published.
* When retries are exhausted the **worker** marks the entry `failed` (the platform never accepted it, so no webhook will ever come). `published` always requires a verified webhook.
* SQLite: single host, single writer. Fine for this scope; the repository layer isolates the swap to Postgres.
* Images are generated placeholders; posts are ingested from pasted text (no URL fetching).
* One shared API key; no per-user auth or tenant isolation.
* `FAULT_CRASH_AFTER_ACCEPT` is a test-only hook compiled into the worker (default off). `ENABLE_DEMO_CONTROLS` must be `false` in any real deployment.
* Docker: `docker compose up` was built and smoke-tested (full publish through the API → `published`), but the automated test suite runs on the host with `npm test`, not in a container.

## Repository map

```
fakeplatform/server.js   the fake social platform (OAuth, 429, idempotency, faults, signed webhooks)
src/                     app: http · services · db · adapters · content · lib
public/index.html        dashboard (status table, review, schedule, history)
scripts/                 start-all, seed, demo
tests/                   82 tests in 8 files: unit, integration, real-process crash tests
docs/DESIGN.md           design doc + brief comparison        EVIDENCE.md  proof per checkbox
BUILDLOG.md              AI-usage log                          capstone.yaml  evaluator manifest
```

MIT licensed.

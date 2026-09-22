# BUILDLOG — AI usage log

**Tool:** Claude Code (Claude Sonnet 5) wrote the implementation in one long session from the two capstone PDFs. **Owner's note:** the submitter must be able to explain any line of this code at the demo; read the "things to be able to explain" list at the bottom and change this log if your own experience differs.

## Where AI helped
* **Choosing the brief.** Read both PDFs, compared them (table in `docs/DESIGN.md`), chose the older *Multi-Platform Social Campaign Publisher* plus the strongest parts of *Social Media Studio* (constraint profiles, review workflow, publish history). The missing `starters/challenge-5-social/` server was replaced by `fakeplatform/server.js`, as the organisers' notice allows.
* **Architecture and code:** layered app (`http → services → repos`), adapter interface, DB-backed durable queue with leases and fenced writes, HMAC webhook verification, AES-256-GCM token store, sharp image pipeline, caption composer, dashboard, scripts, Docker files, docs.
* **Tests:** 82 tests, including real-process crash tests. The tests were written *to try to break* the design (forged/replayed webhooks, kill mid-publish, zombie worker, secrets in DB/WAL/logs), not only to confirm the happy path.

## Where AI was wrong (found by running things, then fixed)
| # | What went wrong | How it surfaced | Fix |
|---|---|---|---|
| 1 | Safe-zone fallback used plain `contain`, which cannot make an oversized subject fit the safe zone | my own test `subject too large … falls back to contain` failed | fallback now shrinks the image until the subject fits, then letterboxes |
| 2 | Repos returned `undefined` (not `null`) for "no row" because of `r && {...}` | queue tests asserted `null` | mappers return `null` explicitly |
| 3 | Worker passed `receipt.url` but the repo read `postUrl` → post URL stayed empty until the webhook arrived | code review while writing evidence | worker maps `url → postUrl` |
| 4 | Fake platform `/reset` also cleared OAuth tokens, so every test silently caused a `401` + refresh + extra request (looked like the worker hammered the API: `2 !== 1`) | 5 rate-limit/idempotency tests failed | `/reset` keeps tokens; separate `/tokens/revoke`. It did prove the 401-refresh path works |
| 5 | My idempotency test assumed the job returns to `queued` after a timeout. In reality the webhook can arrive *during* the platform's hang, and the entry correctly becomes `published` | test failed; reasoning showed the code was right and the test wrong | test now holds webhooks (`/webhooks/hold`) to make the "accepted, unconfirmed" window observable |
| 6 | Crash hook used `process.exit(99)`; on Windows that hit a libuv assertion with sockets in flight (`0xC0000409`) | crash test failed on exit code | hook now `SIGKILL`s its own process (a truer crash); test asserts "died abnormally" |
| 7 | Rendered title text overflowed its card and the brand badge clipped ("Studi") | I opened the generated PNGs and looked at them | wrap at 19 chars; badge sized to its text |
| 8 | Markdown heading `# Retries` was glued onto the next sentence in captions ("Retries Networks fail") | read the live captions from the API | headings are dropped from summaries |
| 9 | `node --test tests/` fails on Node 24 (treats the directory as a module) | first `npm test` | script uses the glob `"tests/*.test.js"` |
| 10 | Default port 3000 was already taken on this machine (unrelated app) | `EADDRINUSE` on first `npm start` | defaults moved to 3100 (app) / 4010 (platform) |

## Decisions made deliberately (be ready to defend)
* **`published` only by webhook**, but the *worker* sets `failed` when retries are exhausted (no webhook will ever come for a post the platform never accepted). Documented in README/EVIDENCE.
* **Idempotency key = `studio-variant-<variantId>`** — independent of time, slot and attempt number, so it is byte-identical on every retry. A slot can move only before the first attempt.
* **429 does not consume the retry budget** and pauses the whole platform (not just one job).
* **Leases use real time, scheduling uses a virtual clock** (real time + persisted offset) so the demo can "advance to tomorrow" without breaking crash recovery.
* **Own DB-backed queue instead of BullMQ/APScheduler:** no Redis dependency, and the crash/lease/fencing behaviour is testable and explainable line by line.
* **`node:sqlite` (built in) instead of a native driver:** zero native build steps besides `sharp`. Requires Node ≥ 22.13.

## Not verified / not done
* No real-platform adapter (Telegram/Discord/Mastodon from the newer brief).
* `SocialPostEntry` was not provided; the record shape is my own.
* No reconciliation poller for a webhook that never arrives.
* Docker was smoke-tested once by hand, not in CI.

## Things to be able to explain at the demo
1. `claimDue` in `src/db/repos.js` — why one `UPDATE … RETURNING` is a safe lock and how an expired lease is reclaimed.
2. `markAccepted`/`scheduleRetry` are fenced by `locked_by` — what a "zombie worker" is.
3. `verify()` in `src/lib/webhookSignature.js` — why the MAC covers `timestamp.rawBody`, and why `express.raw` is used for that route.
4. `HttpPlatformPublisher.send()` — why a timeout is *unknown outcome* and why retrying is only safe with the same idempotency key.
5. `renderVariant()` — the subject-aware crop and the safe-zone fallback.

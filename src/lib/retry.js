const MAX_RETRY_AFTER_MS = 60 * 60_000;
const DEFAULT_RETRY_AFTER_MS = 5_000;

/**
 * Parse a Retry-After header. Per RFC 9110 it is EITHER delay-seconds OR an HTTP-date.
 * Bad/absent values fall back to a conservative default; absurd values are capped.
 */
export function parseRetryAfter(value, nowMs = Date.now()) {
  if (value === null || value === undefined || value === '') return DEFAULT_RETRY_AFTER_MS;
  const v = String(value).trim();
  let ms;
  if (/^\d+$/.test(v)) ms = Number.parseInt(v, 10) * 1000;
  else {
    const at = Date.parse(v);
    if (Number.isNaN(at)) return DEFAULT_RETRY_AFTER_MS;
    ms = at - nowMs;
  }
  return Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS);
}

/**
 * Exponential backoff with "equal jitter": half the window is fixed, half is random.
 * Guarantees real spacing between attempts while de-synchronising many clients so they
 * do not retry in lock-step (AWS Architecture Blog: "Exponential Backoff And Jitter").
 * `attempt` is 1-based (the attempt that just failed).
 */
export function backoffMs(attempt, { baseMs, maxMs }, rng = Math.random) {
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(ceiling / 2 + rng() * (ceiling / 2));
}

// HTTP-facing errors. Anything thrown as AppError becomes a clean 4xx, never a 500.
export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
export const badRequest = (code, msg, details) => new AppError(400, code, msg, details);
export const unauthorized = (msg = 'Missing or invalid API key') => new AppError(401, 'unauthorized', msg);
export const notFound = (what) => new AppError(404, 'not_found', `${what} not found`);
export const conflict = (code, msg, details) => new AppError(409, code, msg, details);
export const unprocessable = (code, msg, details) => new AppError(422, code, msg, details);

// Publishing errors, normalised by adapters so the retry policy lives in ONE place
// and is platform-agnostic.
export class PublishError extends Error {
  /** @param {'rate_limited'|'timeout'|'transient'|'permanent'} kind */
  constructor(kind, message, { retryAfterMs, status } = {}) {
    super(message);
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
    this.status = status;
  }
  get retryable() {
    return this.kind !== 'permanent';
  }
}

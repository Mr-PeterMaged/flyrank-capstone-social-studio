import fs from 'node:fs/promises';
import { SocialPublisher } from './SocialPublisher.js';
import { PublishError } from '../lib/errors.js';
import { parseRetryAfter } from '../lib/retry.js';

/**
 * Shared machinery for adapters that talk to a REST platform API: bearer auth with a
 * one-shot token refresh, idempotency header, and translation of every HTTP / network
 * outcome into the platform-agnostic PublishError taxonomy.
 *
 * Concrete adapters override buildPayload() / endpoint() when their platform's wire
 * format differs; the application never sees any of it.
 */
export class HttpPlatformPublisher extends SocialPublisher {
  constructor({ platform, baseUrl, tokenStore, timeoutMs = 3000, fetchImpl = fetch }) {
    super();
    this._platform = platform;
    this.baseUrl = baseUrl;
    this.tokenStore = tokenStore;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
  }

  get platform() {
    return this._platform;
  }

  endpoint() {
    return `${this.baseUrl}/v1/${this.platform}/posts`;
  }

  async buildPayload({ caption, imagePath }, spec) {
    const bytes = await fs.readFile(imagePath);
    return { caption, image: { base64: bytes.toString('base64'), ...spec } };
  }

  async publish(request) {
    const body = JSON.stringify(await this.buildPayload(request, {}));
    let res = await this.send(request.idempotencyKey, body);
    if (res.status === 401) {
      // Token expired or revoked: get a fresh one and retry ONCE. Safe because the
      // request carries the same idempotency key.
      this.tokenStore.invalidate(this.platform);
      res = await this.send(request.idempotencyKey, body);
    }
    return this.interpret(res);
  }

  async send(idempotencyKey, body) {
    let token;
    try {
      token = await this.tokenStore.getAccessToken(this.platform);
    } catch (err) {
      throw new PublishError('transient', `OAuth token unavailable: ${err.message}`);
    }
    try {
      return await this.fetch(this.endpoint(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          'idempotency-key': idempotencyKey,
        },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      // We do NOT know whether the platform processed the request. Retrying with the same
      // idempotency key is exactly what makes that uncertainty safe.
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        throw new PublishError('timeout', `Platform did not answer within ${this.timeoutMs}ms (outcome unknown)`);
      }
      throw new PublishError('transient', `Network error: ${err?.cause?.code ?? err?.message ?? 'unknown'}`);
    }
  }

  async interpret(res) {
    if (res.status === 200 || res.status === 201) {
      const json = await res.json();
      return { platformPostId: json.id, url: json.url, replayed: res.headers.get('idempotent-replayed') === 'true' };
    }
    const detail = await res.text().then((t) => t.slice(0, 300)).catch(() => '');
    if (res.status === 429) {
      throw new PublishError('rate_limited', 'Rate limited by platform', {
        status: 429,
        retryAfterMs: parseRetryAfter(res.headers.get('retry-after')),
      });
    }
    if (res.status >= 500 || res.status === 408 || res.status === 401) {
      throw new PublishError('transient', `Platform HTTP ${res.status}`, { status: res.status });
    }
    throw new PublishError('permanent', `Platform rejected the post (HTTP ${res.status}): ${detail}`, { status: res.status });
  }
}

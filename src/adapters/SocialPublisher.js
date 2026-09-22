/**
 * The seam between the application and every platform.
 *
 * The application (worker, services, HTTP layer) depends ONLY on this contract. It never
 * imports a concrete adapter and never branches on a platform name. Adding a platform
 * means writing one adapter class and registering it in adapters/index.js.
 *
 * Contract for publish():
 *   - MUST send request.idempotencyKey to the platform so a retry can never create a
 *     second post.
 *   - MUST resolve to a receipt when the platform ACCEPTED the post (replays included).
 *   - MUST reject with a PublishError whose `kind` classifies the failure:
 *       'rate_limited' (+ retryAfterMs), 'timeout' (outcome UNKNOWN), 'transient',
 *       or 'permanent'. Raw HTTP/network errors must never leak out.
 *   - MUST NOT retry publishing itself: retries are durable (persisted, scheduled) and
 *     owned by the worker. (A one-shot OAuth refresh on 401 is the only exception.)
 *
 * @typedef {Object} PublishRequest
 * @property {string} idempotencyKey
 * @property {string} caption
 * @property {string} imagePath   absolute path of the platform-sized image
 * @property {string} link        canonical URL of the blog post
 *
 * @typedef {Object} PublishReceipt
 * @property {string} platformPostId
 * @property {string} [url]
 * @property {boolean} replayed   true when the platform recognised the idempotency key
 */
export class SocialPublisher {
  /** @returns {string} the platform id this adapter serves, e.g. "instagram" */
  get platform() {
    throw new Error('SocialPublisher.platform must be implemented');
  }

  /** @param {PublishRequest} _request @returns {Promise<PublishReceipt>} */
  async publish(_request) {
    throw new Error('SocialPublisher.publish must be implemented');
  }
}

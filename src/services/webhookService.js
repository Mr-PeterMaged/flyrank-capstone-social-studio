import { z } from 'zod';
import { verify } from '../lib/webhookSignature.js';
import { badRequest } from '../lib/errors.js';
import { log } from '../lib/logger.js';

const EventSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['post.published', 'post.failed']),
  created: z.number().optional(),
  data: z.object({
    post_id: z.string().min(1),
    idempotency_key: z.string().min(1),
    platform: z.string().min(1),
    url: z.string().optional(),
    reason: z.string().optional(),
  }),
});

/**
 * Trust boundary. The ONLY code path that can set a post to published (or failed by
 * platform verdict). Order matters: verify the signature over the RAW bytes first, and
 * touch nothing until it passes.
 */
export function createWebhookService({ repos, config }) {
  return {
    /**
     * @param {string} rawBody exact bytes received (never a re-serialised object)
     * @param {string|undefined} signatureHeader
     * @returns {{status: number, body: object}}
     */
    handleDelivery(rawBody, signatureHeader) {
      const check = verify(rawBody, signatureHeader, config.webhook.secret, { toleranceSec: config.webhook.toleranceSec });
      if (!check.ok) {
        // Log the reason for operators; tell the caller nothing useful.
        log.warn('webhook rejected', { reason: check.reason });
        throw badRequest('invalid_signature', 'Webhook signature verification failed');
      }

      let event;
      try {
        event = EventSchema.parse(JSON.parse(rawBody));
      } catch {
        throw badRequest('invalid_event', 'Webhook body is not a valid delivery event');
      }

      const entry = repos.socialPosts.getByIdempotencyKey(event.data.idempotency_key);
      if (!entry || entry.platform !== event.data.platform) {
        // Authentic but not ours (or stale). 2xx so the platform stops retrying it.
        log.warn('webhook for unknown post ignored', { eventId: event.id });
        return { status: 202, body: { ok: true, ignored: 'unknown_post' } };
      }

      const outcome = event.type === 'post.published' ? 'published' : 'failed';
      return repos.tx(() => {
        const applied = repos.socialPosts.applyDelivery(entry.id, outcome, { postUrl: event.data.url, reason: event.data.reason });
        const firstTime = repos.webhookEvents.tryRecord({
          eventId: event.id,
          socialPostId: entry.id,
          type: event.type,
          outcome: applied ? 'applied' : 'ignored',
        });
        if (applied) {
          repos.attempts.record({
            socialPostId: entry.id,
            attemptNo: entry.attempts,
            outcome: outcome === 'published' ? 'delivered' : 'delivery_failed',
            detail: `${event.type} ${event.id}`,
          });
          log.info('delivery confirmed', { socialPostId: entry.id, platform: entry.platform, status: outcome });
        }
        return { status: 200, body: { ok: true, applied: Boolean(applied), duplicate: !firstTime } };
      });
    },
  };
}

import { conflict, notFound, unprocessable } from '../lib/errors.js';

/**
 * Turns approved variants into durable jobs (social_posts rows).
 *
 * Idempotency lives at three layers, so no single bug can cause a duplicate post:
 *   1. here      - scheduling the same variant again returns the existing entry;
 *   2. database  - UNIQUE(variant_id) and UNIQUE(idempotency_key);
 *   3. platform  - the idempotency key sent with every publish attempt.
 * The key is derived from the variant id ONLY (never the slot, never an attempt number):
 * one variant == one post, so it is identical on every retry, restart and re-schedule.
 */
export function createSchedulingService({ repos, clock }) {
  const keyFor = (variant) => `studio-variant-${variant.id}`;

  return {
    /**
     * @param {number} campaignId
     * @param {{atMs: number, platforms?: string[]}} opts   atMs is on the scheduler clock
     */
    schedule(campaignId, { atMs, platforms, preserveExisting = false }) {
      const campaign = repos.campaigns.get(campaignId);
      if (!campaign) throw notFound('Campaign');

      let variants = repos.variants.listByCampaign(campaignId);
      if (platforms?.length) {
        const missing = platforms.filter((p) => !variants.some((v) => v.platform === p));
        if (missing.length) throw unprocessable('unknown_platform', `Campaign has no variant for: ${missing.join(', ')}`);
        variants = variants.filter((v) => platforms.includes(v.platform));
      }
      if (!variants.length) throw unprocessable('nothing_to_schedule', 'Campaign has no variants');

      // Nothing unapproved ever goes out. All-or-nothing: if any targeted variant is not
      // approved, NOTHING is scheduled and the caller learns exactly which ones and why.
      const unapproved = variants.filter((v) => v.reviewStatus !== 'approved');
      if (unapproved.length) {
        throw conflict('variant_not_approved', 'Only approved variants can be scheduled', {
          variants: unapproved.map((v) => ({ id: v.id, platform: v.platform, reviewStatus: v.reviewStatus })),
        });
      }

      return repos.tx(() =>
        variants.map((variant) => {
          const { entry, created } = repos.socialPosts.createIfAbsent({
            variantId: variant.id,
            campaignId,
            platform: variant.platform,
            idempotencyKey: keyFor(variant),
            scheduledAt: atMs,
          });
          if (created) return { entry, replayed: false };
          // Already exists. A different slot is honoured only while nothing has been
          // attempted; after that the key is "in the wild" and the slot is frozen.
          if (!preserveExisting && entry.scheduledAt !== atMs) {
            const moved = repos.socialPosts.reschedule(entry.id, atMs);
            if (moved) return { entry: moved, replayed: true, rescheduled: true };
          }
          return { entry, replayed: true };
        }),
      );
    },

    publishNow(campaignId, opts = {}) {
      // "now" is a moving target: a repeated publish must never nudge an existing slot.
      return this.schedule(campaignId, { ...opts, atMs: clock.now(), preserveExisting: true });
    },
  };
}

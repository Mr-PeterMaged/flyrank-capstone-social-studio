import crypto from 'node:crypto';
import path from 'node:path';
import { PublishError } from '../lib/errors.js';
import { backoffMs } from '../lib/retry.js';
import { log } from '../lib/logger.js';

/**
 * The durable publisher. All state lives in the database (social_posts), none in memory,
 * so a crash at ANY line below loses nothing:
 *
 *   claim (atomic UPDATE, sets a lease)          <- crash here: lease expires, job reclaimed
 *     -> adapter.publish(idempotencyKey)         <- crash here: reclaimed, same key => platform
 *                                                   replays the original post, no duplicate
 *     -> markAccepted                            <- crash here: same as above
 *   ... signed webhook later flips status to published | failed
 *
 * The retry policy (backoff, Retry-After, attempt budget) lives here, once, and is
 * platform-agnostic because adapters only speak PublishError.
 */
export class PublishWorker {
  constructor({ repos, clock, publishers, config, workerId = `worker-${crypto.randomBytes(3).toString('hex')}`, rng = Math.random }) {
    this.repos = repos;
    this.clock = clock;
    this.publishers = publishers;
    this.config = config;
    this.workerId = workerId;
    this.rng = rng;
    this.timer = null;
    this.running = null;
  }

  /** Claim what is due and process it. Returns the number of jobs handled. */
  async tick() {
    const { worker } = this.config;
    const jobs = this.repos.socialPosts.claimDue({
      workerId: this.workerId,
      now: this.clock.now(),
      realNow: Date.now(),
      leaseMs: worker.leaseMs,
      limit: worker.batchSize,
    });
    // Jobs in one batch are independent; a slow platform must not delay the others.
    await Promise.allSettled(jobs.map((job) => this.process(job)));
    return jobs.length;
  }

  async process(job) {
    const { worker } = this.config;
    const record = (outcome, extra = {}) =>
      this.repos.attempts.record({ socialPostId: job.id, attemptNo: job.attempts, workerId: this.workerId, outcome, ...extra });

    if (job.attempts > worker.maxAttempts) {
      this.repos.socialPosts.markFailed(job.id, 'max_attempts_exceeded');
      record('gave_up', { detail: `exceeded ${worker.maxAttempts} attempts` });
      log.warn('publish gave up', { socialPostId: job.id, platform: job.platform });
      return;
    }

    const variant = this.repos.variants.get(job.variantId);
    // Last line of defence for "nothing unapproved ever publishes".
    if (!variant || variant.reviewStatus !== 'approved') {
      this.repos.socialPosts.markFailed(job.id, 'variant_not_approved');
      record('blocked', { detail: 'variant is not approved' });
      return;
    }

    try {
      const post = this.repos.posts.get(this.repos.campaigns.get(job.campaignId).post_id);
      const receipt = await this.publishers.get(job.platform).publish({
        idempotencyKey: job.idempotencyKey,
        caption: variant.caption,
        imagePath: path.join(this.config.artifactDir, variant.imagePath),
        link: post.url,
      });

      if (this.config.faults.crashAfterAccept) {
        // Test hook: die like a killed process (SIGKILL), AFTER the platform accepted, BEFORE we recorded it.
        log.warn('FAULT: simulating crash after platform accepted the post', { socialPostId: job.id });
        process.kill(process.pid, 'SIGKILL'); // hard kill: no handlers, no cleanup
      }

      const updated = this.repos.socialPosts.markAccepted(job.id, this.workerId, {
        platformPostId: receipt.platformPostId,
        postUrl: receipt.url,
      });
      record(receipt.replayed ? 'accepted_replayed' : 'accepted', { httpStatus: receipt.replayed ? 200 : 201, detail: receipt.platformPostId });
      if (!updated) log.warn('accepted, but the job moved on (webhook or another worker got there first)', { socialPostId: job.id });
    } catch (err) {
      this.handleFailure(job, err, record);
    }
  }

  handleFailure(job, err, record) {
    const { worker } = this.config;
    if (!(err instanceof PublishError)) {
      // A bug or unexpected exception is treated as transient: retry with backoff, and the
      // attempt budget guarantees it cannot loop forever.
      err = new PublishError('transient', `Unexpected error: ${err?.message ?? err}`);
    }

    if (err.kind === 'permanent') {
      this.repos.socialPosts.markFailed(job.id, err.message);
      record('permanent_error', { httpStatus: err.status, detail: err.message });
      log.warn('publish failed permanently', { socialPostId: job.id, platform: job.platform, reason: err.message });
      return;
    }

    if (err.kind === 'rate_limited') {
      // Honour Retry-After for THIS job and pause the whole platform, so the other jobs
      // in the batch (and other workers) do not walk into the same 429.
      const jitter = Math.round(err.retryAfterMs * 0.1 * this.rng());
      const until = this.clock.now() + err.retryAfterMs + jitter;
      this.repos.limits.block(job.platform, until);
      this.repos.socialPosts.scheduleRetry(job.id, this.workerId, {
        nextAttemptAt: until,
        error: `rate_limited (Retry-After ${Math.round(err.retryAfterMs / 1000)}s)`,
        refundAttempt: true,
      });
      record('rate_limited', { httpStatus: 429, detail: `waiting ${Math.round((until - this.clock.now()) / 1000)}s` });
      log.info('rate limited; platform paused', { platform: job.platform, retryAfterMs: err.retryAfterMs });
      return;
    }

    // timeout (outcome unknown) or transient: retry with the SAME idempotency key.
    if (job.attempts >= worker.maxAttempts) {
      this.repos.socialPosts.markFailed(job.id, `retries exhausted: ${err.message}`);
      record('gave_up', { detail: err.message });
      log.warn('publish gave up after retries', { socialPostId: job.id, platform: job.platform });
      return;
    }
    const delay = backoffMs(job.attempts, { baseMs: worker.backoffBaseMs, maxMs: worker.backoffMaxMs }, this.rng);
    this.repos.socialPosts.scheduleRetry(job.id, this.workerId, { nextAttemptAt: this.clock.now() + delay, error: err.message });
    record(err.kind === 'timeout' ? 'timeout_unknown' : 'transient_error', { detail: `${err.message}; retry in ${delay}ms` });
    log.info('publish will retry', { socialPostId: job.id, platform: job.platform, kind: err.kind, delayMs: delay });
  }

  start() {
    if (this.timer) return;
    const loop = async () => {
      try {
        // Drain: keep going while there is due work, then sleep.
        while ((await this.tick()) > 0);
      } catch (err) {
        log.error('worker tick failed', { error: err });
      }
    };
    this.timer = setInterval(() => {
      if (this.running) return; // never overlap ticks
      this.running = loop().finally(() => (this.running = null));
    }, this.config.worker.pollMs);
    this.timer.unref?.();
    log.info('worker started', { workerId: this.workerId });
  }

  async stop() {
    clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }
}

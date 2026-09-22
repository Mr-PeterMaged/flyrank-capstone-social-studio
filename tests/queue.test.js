import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { createRepos } from '../src/db/repos.js';

// Deterministic tests of the durable-queue primitives: leases, fencing, reclaim, rate pauses.
describe('durable queue primitives', () => {
  let repos;
  let entry;

  beforeEach(() => {
    repos = createRepos(openDb(':memory:'));
    const post = repos.posts.create({ title: 't', body: 'b', url: 'https://e.co' });
    const campaign = repos.campaigns.create(post.id);
    const variant = repos.variants.create({
      campaignId: campaign.id, platform: 'x', caption: 'c https://e.co', imagePath: 'p.png',
      imageWidth: 1600, imageHeight: 900, reviewStatus: 'approved',
    });
    entry = repos.socialPosts.createIfAbsent({
      variantId: variant.id, campaignId: campaign.id, platform: 'x', idempotencyKey: `studio-variant-${variant.id}`, scheduledAt: 1000,
    }).entry;
  });

  const claim = (workerId, { now = 5000, realNow = 5000, leaseMs = 100 } = {}) =>
    repos.socialPosts.claimDue({ workerId, now, realNow, leaseMs, limit: 10 });

  test('createIfAbsent is idempotent: one row per variant, ever', () => {
    const again = repos.socialPosts.createIfAbsent({
      variantId: entry.variantId, campaignId: entry.campaignId, platform: 'x', idempotencyKey: 'other-key', scheduledAt: 9,
    });
    assert.equal(again.created, false);
    assert.equal(again.entry.id, entry.id);
    assert.equal(again.entry.idempotencyKey, entry.idempotencyKey, 'the original key is kept');
    assert.equal(repos.db.prepare('SELECT COUNT(*) n FROM social_posts').get().n, 1);
  });

  test('a job is not due before its slot', () => {
    assert.equal(claim('A', { now: 999 }).length, 0);
    assert.equal(claim('A', { now: 1000 }).length, 1);
  });

  test('a claimed job cannot be claimed again while its lease is alive', () => {
    assert.equal(claim('A', { realNow: 5000 }).length, 1);
    assert.equal(claim('B', { realNow: 5050 }).length, 0);
  });

  test('crash recovery: after the lease expires another worker reclaims the job', () => {
    const [a] = claim('A', { realNow: 5000 });
    assert.equal(a.attempts, 1);
    const [b] = claim('B', { realNow: 5101 });
    assert.equal(b.id, entry.id);
    assert.equal(b.lockedBy, 'B');
    assert.equal(b.attempts, 2);
    assert.equal(b.idempotencyKey, a.idempotencyKey, 'same key on every attempt');
  });

  test('fencing: a zombie worker whose lease expired cannot overwrite the new owner', () => {
    claim('A', { realNow: 5000 });
    claim('B', { realNow: 5101 });
    assert.equal(repos.socialPosts.markAccepted(entry.id, 'A', { platformPostId: 'zombie' }), null);
    assert.equal(repos.socialPosts.scheduleRetry(entry.id, 'A', { nextAttemptAt: 1, error: 'x' }), null);
    const ok = repos.socialPosts.markAccepted(entry.id, 'B', { platformPostId: 'real' });
    assert.equal(ok.platformPostId, 'real');
  });

  test('a post the platform already accepted is never re-claimed, even with an expired lease', () => {
    claim('A', { realNow: 5000 });
    repos.socialPosts.markAccepted(entry.id, 'A', { platformPostId: 'p1' });
    assert.equal(claim('B', { realNow: 999999 }).length, 0);
  });

  test('terminal states are final: applyDelivery cannot move published/failed', () => {
    claim('A');
    assert.equal(repos.socialPosts.applyDelivery(entry.id, 'published', {}).status, 'published');
    assert.equal(repos.socialPosts.applyDelivery(entry.id, 'failed', { reason: 'x' }), null);
    assert.equal(repos.socialPosts.markFailed(entry.id, 'x'), null);
    assert.equal(repos.socialPosts.get(entry.id).status, 'published');
  });

  test('a rate-limited platform is paused for every job until blocked_until', () => {
    repos.limits.block('x', 8000);
    assert.equal(claim('A', { now: 7999 }).length, 0);
    assert.equal(claim('A', { now: 8001 }).length, 1);
  });

  test('a block is never shortened by a later, shorter Retry-After', () => {
    repos.limits.block('x', 9000);
    repos.limits.block('x', 6000);
    assert.equal(repos.limits.list()[0].blocked_until, 9000);
  });

  test('scheduleRetry with refundAttempt does not consume the retry budget', () => {
    claim('A');
    const r = repos.socialPosts.scheduleRetry(entry.id, 'A', { nextAttemptAt: 6000, error: 'rate_limited', refundAttempt: true });
    assert.equal(r.attempts, 0);
    assert.equal(r.status, 'queued');
  });

  test('database constraints backstop duplicates: two rows for one variant are impossible', () => {
    assert.throws(() =>
      repos.db.prepare(`INSERT INTO social_posts (variant_id, campaign_id, platform, status, idempotency_key, scheduled_at, next_attempt_at, created_at, updated_at)
                        VALUES (?,?,?,?,?,?,?,?,?)`).run(entry.variantId, entry.campaignId, 'x', 'queued', 'another', 1, 1, 1, 1),
    );
  });
});

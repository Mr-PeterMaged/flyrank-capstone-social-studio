import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setup, waitFor, sleep } from './helpers.js';

const allPublished = (t, id, platforms) => async () => {
  const s = await t.statuses(id);
  return platforms.every((p) => s[p] === 'published') && s;
};

describe('publishing pipeline against the fake platform', () => {
  let t;
  before(async () => {
    t = await setup();
  });
  after(() => t.teardown());
  beforeEach(async () => {
    await t.admin('/reset');
    await t.admin('/webhooks/hold', { hold: false });
  });

  test('happy path: approve -> publish -> worker -> signed webhook -> published, one post per platform', async () => {
    const c = await t.approvedCampaign();
    const res = await t.api('POST', `/api/campaigns/${c.id}/publish`, {});
    assert.equal(res.status, 201);
    assert.deepEqual(res.body.entries.map((e) => e.status), ['queued', 'queued', 'queued']);

    await t.tickAll();
    await waitFor(allPublished(t, c.id, ['instagram', 'x', 'linkedin']), { message: 'all published' });

    const posts = [...t.platform.state.posts.values()];
    assert.equal(posts.length, 3);
    assert.deepEqual(posts.map((p) => p.platform).sort(), ['instagram', 'linkedin', 'x']);
    const final = await t.getCampaign(c.id);
    assert.equal(final.status, 'published');
    for (const v of final.variants) {
      assert.match(v.socialPost.postUrl, /\/p\/post_/);
      assert.ok(v.socialPost.publishedAt);
    }
  });

  test('IDEMPOTENCY (probe 1): hammering publish 5x, then a timed-out retry -> exactly 1 post per platform', async () => {
    const c = await t.approvedCampaign();
    // Hold delivery webhooks so "accepted, awaiting confirmation" stays observable.
    await t.admin('/webhooks/hold', { hold: true });
    // First attempt on each platform: the platform ACCEPTS the post but the response never arrives.
    await t.admin('/faults', { faults: ['timeout_after_accept', 'timeout_after_accept', 'timeout_after_accept'] });

    const responses = await Promise.all(Array.from({ length: 5 }, () => t.api('POST', `/api/campaigns/${c.id}/publish`, {})));
    assert.equal(responses.filter((r) => r.status === 201).length, 1, 'exactly one request created the jobs');
    const ids = new Set(responses.flatMap((r) => r.body.entries.map((e) => e.id)));
    assert.equal(ids.size, 3, 'five requests, still only three jobs');

    await t.tickAll(); // every publish times out (client gives up after 600ms)
    let s = await t.statuses(c.id);
    assert.ok(Object.values(s).every((x) => x === 'queued'), `timed-out jobs go back to the queue: ${JSON.stringify(s)}`);
    assert.equal(t.platform.state.posts.size, 3, 'the platform already accepted them (that is the danger)');

    // Retry storm: keep ticking until the platform has acknowledged every job.
    await waitFor(async () => {
      await t.tickAll();
      const v = (await t.getCampaign(c.id)).variants;
      return v.every((x) => x.socialPost.platformPostId);
    }, { message: 'retries to converge' });
    s = await t.statuses(c.id);
    assert.ok(Object.values(s).every((x) => x === 'publishing'), `accepted is NOT published until the webhook: ${JSON.stringify(s)}`);

    await t.admin('/webhooks/hold', { hold: false });
    await t.admin('/webhooks/flush');
    await waitFor(allPublished(t, c.id, ['instagram', 'x', 'linkedin']), { message: 'webhooks to confirm' });

    assert.equal(t.platform.state.posts.size, 3, 'STILL exactly 3 posts on the platform');
    assert.equal(t.platform.state.stats.created, 3);
    assert.ok(t.platform.state.stats.replays >= 3, 'retries were recognised as replays by the idempotency key');
    const hist = (await t.api('GET', `/api/campaigns/${c.id}/history`)).body;
    assert.ok(hist.some((h) => h.outcome === 'timeout_unknown'));
    assert.ok(hist.some((h) => h.outcome === 'accepted_replayed'));
  });

  test('publishing twice after completion is a no-op (200 replay), never a second post', async () => {
    const c = await t.approvedCampaign(['x']);
    await t.api('POST', `/api/campaigns/${c.id}/publish`, {});
    await t.tickAll();
    await waitFor(allPublished(t, c.id, ['x']));
    const again = await t.api('POST', `/api/campaigns/${c.id}/publish`, {});
    assert.equal(again.status, 200);
    assert.equal(again.body.entries[0].replayed, true);
    await t.tickAll();
    assert.equal(t.platform.state.posts.size, 1);
    assert.equal(t.platform.state.stats.publishRequests, 1);
  });

  test('two workers racing over the same database never double-claim a job', async () => {
    const { createContainer } = await import('../src/container.js');
    const other = createContainer({ ...t.config, worker: { ...t.config.worker, batchSize: 1 } }, { workerId: 'second-worker' });
    try {
      const c = await t.approvedCampaign();
      await t.api('POST', `/api/campaigns/${c.id}/publish`, {});
      await Promise.all([other.worker.tick(), t.container.worker.tick(), other.worker.tick(), other.worker.tick()]);
      await waitFor(allPublished(t, c.id, ['instagram', 'x', 'linkedin']));
      assert.equal(t.platform.state.stats.publishRequests, 3, 'each job was attempted exactly once');
      assert.equal(t.platform.state.posts.size, 3);
    } finally {
      other.close();
    }
  });

  test('RATE LIMIT (probe 2): 429 + Retry-After is honoured, the platform is not hammered, then it succeeds', async () => {
    const c = await t.approvedCampaign(['x']);
    await t.admin('/rate-limit', { retryAfter: 1, platform: 'x' });
    await t.api('POST', `/api/campaigns/${c.id}/publish`, {});

    await t.tickAll();
    assert.equal(t.platform.state.stats.rateLimited, 1);
    const entry = (await t.getCampaign(c.id)).variants[0].socialPost;
    assert.equal(entry.status, 'queued');
    assert.match(entry.lastError, /rate_limited/);
    assert.equal(entry.attempts, 0, '429 does not consume the retry budget');
    assert.equal((await t.api('GET', '/api/admin/limits')).body[0].platform, 'x', 'platform is paused for everyone');

    // While the window is open the worker must not even try.
    for (let i = 0; i < 5; i++) {
      await t.tickAll();
      await sleep(100);
    }
    assert.equal(t.platform.state.stats.publishRequests, 1, 'no request during Retry-After');
    assert.equal(t.platform.state.stats.violations, 0);

    await waitFor(async () => {
      await t.tickAll();
      return allPublished(t, c.id, ['x'])();
    }, { timeout: 6000, message: 'publish after Retry-After' });
    assert.equal(t.platform.state.stats.publishRequests, 2, 'exactly one retry, once allowed');
    assert.equal(t.platform.state.stats.violations, 0);
    assert.equal(t.platform.state.posts.size, 1);
    const hist = (await t.api('GET', `/api/campaigns/${c.id}/history`)).body;
    assert.ok(hist.some((h) => h.outcome === 'rate_limited' && h.http_status === 429));
  });

  test('a 429 on one platform does not stall the others', async () => {
    const c = await t.approvedCampaign();
    await t.admin('/rate-limit', { retryAfter: 2, platform: 'x' });
    await t.api('POST', `/api/campaigns/${c.id}/publish`, {});
    await t.tickAll();
    await waitFor(allPublished(t, c.id, ['instagram', 'linkedin']));
    assert.equal((await t.statuses(c.id)).x, 'queued');
    assert.equal(t.platform.state.stats.violations, 0);
    await waitFor(async () => {
      await t.tickAll();
      return allPublished(t, c.id, ['x'])();
    }, { timeout: 6000, message: 'x to publish after its own Retry-After' });
  });

  test('transient 500s are retried with backoff using the same key', async () => {
    const c = await t.approvedCampaign(['instagram']);
    await t.admin('/faults', { faults: ['error_500', 'error_500'] });
    await t.api('POST', `/api/campaigns/${c.id}/publish`, {});
    await waitFor(async () => {
      await t.tickAll();
      return allPublished(t, c.id, ['instagram'])();
    });
    assert.equal(t.platform.state.stats.publishRequests, 3);
    assert.equal(t.platform.state.posts.size, 1);
    const entry = (await t.getCampaign(c.id)).variants[0].socialPost;
    assert.equal(entry.attempts, 3);
  });

  test('retries are bounded: a dead platform ends in failed, not an infinite loop', async () => {
    const c = await t.approvedCampaign(['linkedin']);
    await t.admin('/config', { publishFailRate: 1 });
    await t.api('POST', `/api/campaigns/${c.id}/publish`, {});
    try {
      await waitFor(async () => {
        await t.tickAll();
        return (await t.statuses(c.id)).linkedin === 'failed';
      }, { timeout: 10_000 });
    } finally {
      await t.admin('/config', { publishFailRate: 0 });
    }
    const entry = (await t.getCampaign(c.id)).variants[0].socialPost;
    assert.equal(entry.attempts, 6);
    assert.match(entry.lastError, /retries exhausted/);
    assert.equal(t.platform.state.posts.size, 0);
  });

  test('permanent rejection (HTTP 4xx) fails immediately without retrying', async () => {
    const c = await t.approvedCampaign(['x']);
    // Bypass validation on purpose: an over-long caption straight into the DB.
    t.container.db.prepare("UPDATE variants SET caption = ? WHERE campaign_id = ?").run('z'.repeat(400) + ' https://e.co', c.id);
    await t.api('POST', `/api/campaigns/${c.id}/publish`, {});
    await t.tickAll();
    const entry = (await t.getCampaign(c.id)).variants[0].socialPost;
    assert.equal(entry.status, 'failed');
    assert.match(entry.lastError, /caption_too_long/);
    assert.equal(t.platform.state.stats.publishRequests, 1);
  });

  test('OAuth: an expired/revoked token is refreshed transparently and the publish still succeeds', async () => {
    const c = await t.approvedCampaign(['x']);
    // Prime a token, then have the platform forget it (revocation / expiry).
    await t.container.tokenStore.getAccessToken('x');
    await t.admin('/tokens/revoke');
    const issuedBefore = t.platform.state.stats.tokensIssued;
    await t.api('POST', `/api/campaigns/${c.id}/publish`, {});
    await t.tickAll();
    await waitFor(allPublished(t, c.id, ['x']));
    assert.equal(t.platform.state.stats.tokensIssued, issuedBefore + 1);
    assert.equal(t.platform.state.posts.size, 1);
  });

  test('defence in depth: a job whose variant is not approved never reaches the platform', async () => {
    const c = await t.approvedCampaign(['x']);
    await t.api('POST', `/api/campaigns/${c.id}/schedule`, { inSeconds: 3600 });
    t.container.db.prepare("UPDATE variants SET review_status = 'rejected' WHERE campaign_id = ?").run(c.id);
    t.container.clock.advance(7200 * 1000);
    try {
      await t.tickAll();
    } finally {
      t.container.clock.reset();
    }
    const entry = (await t.getCampaign(c.id)).variants[0].socialPost;
    assert.equal(entry.status, 'failed');
    assert.equal(entry.lastError, 'variant_not_approved');
    assert.equal(t.platform.state.stats.publishRequests, 0);
  });
});

describe('durable scheduling with a virtual clock', () => {
  let t;
  before(async () => {
    t = await setup();
  });
  after(() => t.teardown());
  beforeEach(() => t.admin('/reset'));

  test('a post scheduled for "tomorrow 09:00" waits, then publishes once the clock passes it', async () => {
    const c = await t.approvedCampaign(['x', 'instagram']);
    const target = new Date(t.container.clock.now() + 24 * 3600_000).toISOString();
    const res = await t.api('POST', `/api/campaigns/${c.id}/schedule`, { at: target });
    assert.equal(res.status, 201);

    assert.equal(await t.tickAll(), 0, 'not due yet');
    assert.equal(t.platform.state.stats.publishRequests, 0);
    assert.deepEqual(Object.values(await t.statuses(c.id)), ['queued', 'queued']);

    const clock = (await t.api('POST', '/api/admin/clock/advance', { seconds: 24 * 3600 + 5 })).body;
    assert.ok(Date.parse(clock.schedulerNow) > Date.parse(target));
    assert.equal((await t.api('POST', '/api/admin/worker/tick')).body.handled, 2);
    await waitFor(allPublished(t, c.id, ['x', 'instagram']));
    assert.equal(t.platform.state.posts.size, 2);
  });

  test('the slot is frozen once an attempt has started', async () => {
    const c = await t.approvedCampaign(['x']);
    await t.admin('/faults', { faults: ['error_500'] });
    await t.api('POST', `/api/campaigns/${c.id}/schedule`, { inSeconds: 0 });
    await t.tickAll(); // attempt #1 fails with a 500 -> back in the queue with attempts = 1
    const queued = (await t.getCampaign(c.id)).variants[0].socialPost;
    assert.equal(queued.attempts, 1);
    const before = queued.scheduledAt;

    const again = await t.api('POST', `/api/campaigns/${c.id}/schedule`, { at: '2040-01-01T00:00:00Z' });
    assert.equal(again.status, 200);
    assert.ok(!again.body.entries[0].rescheduled, 'the idempotency key is in the wild; slot must not move');
    assert.equal(again.body.entries[0].scheduledAt, before);

    await waitFor(async () => {
      await t.tickAll();
      return allPublished(t, c.id, ['x'])();
    });
    assert.equal(t.platform.state.posts.size, 1);
  });
});

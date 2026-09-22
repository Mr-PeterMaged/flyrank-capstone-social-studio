import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sign } from '../src/lib/webhookSignature.js';
import { setup, waitFor } from './helpers.js';

describe('signed delivery webhook: the trust boundary', () => {
  let t;
  before(async () => {
    t = await setup();
  });
  after(() => t.teardown());
  beforeEach(async () => {
    await t.admin('/reset');
    await t.admin('/webhooks/hold', { hold: true }); // the REAL platform stays quiet; we play the sender
  });

  /** A job the platform has accepted (post exists) but has not confirmed yet. */
  async function acceptedEntry(platforms = ['x']) {
    const c = await t.approvedCampaign(platforms);
    await t.api('POST', `/api/campaigns/${c.id}/publish`, {});
    await t.tickAll();
    const entry = (await t.getCampaign(c.id)).variants[0].socialPost;
    assert.equal(entry.status, 'publishing');
    assert.ok(entry.platformPostId);
    return { c, entry };
  }

  const event = (entry, type = 'post.published', id = `evt_${Math.random().toString(16).slice(2)}`) => ({
    id,
    type,
    created: Math.floor(Date.now() / 1000),
    data: {
      post_id: entry.platformPostId,
      idempotency_key: entry.idempotencyKey,
      platform: entry.platform,
      url: `https://social.example/p/${entry.platformPostId}`,
      ...(type === 'post.failed' ? { reason: 'media_processing_failed' } : {}),
    },
  });

  const send = (raw, headers = {}) =>
    fetch(`${t.baseUrl}/webhook/social-delivery`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: raw });

  const statusOf = async (c) => (await t.getCampaign(c.id)).variants[0].socialPost.status;

  test('FORGED webhook (signed with the wrong secret) -> 400, status unchanged (probe 4)', async () => {
    const { c, entry } = await acceptedEntry();
    const raw = JSON.stringify(event(entry));
    const res = await send(raw, { 'x-signature': sign(raw, 'attacker-guess') });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'invalid_signature');
    assert.equal(await statusOf(c), 'publishing');
  });

  test('unsigned webhook -> 400; sending the API key instead of a signature does not help', async () => {
    const { c, entry } = await acceptedEntry();
    const raw = JSON.stringify(event(entry));
    assert.equal((await send(raw)).status, 400);
    assert.equal((await send(raw, { authorization: `Bearer ${t.secrets.apiKey}` })).status, 400);
    assert.equal(await statusOf(c), 'publishing');
  });

  test('MODIFIED webhook (valid signature, body changed after signing) -> 400', async () => {
    const { c, entry } = await acceptedEntry();
    const signedFor = JSON.stringify(event(entry, 'post.failed', 'evt_a'));
    const sig = sign(signedFor, t.secrets.webhookSecret);
    const tampered = signedFor.replace('post.failed', 'post.published');
    assert.equal((await send(tampered, { 'x-signature': sig })).status, 400);
    assert.equal(await statusOf(c), 'publishing');
  });

  test('REPLAYED old webhook (validly signed an hour ago) -> 400', async () => {
    const { c, entry } = await acceptedEntry();
    const raw = JSON.stringify(event(entry));
    const old = sign(raw, t.secrets.webhookSecret, Math.floor(Date.now() / 1000) - 3600);
    assert.equal((await send(raw, { 'x-signature': old })).status, 400);
    assert.equal(await statusOf(c), 'publishing');
  });

  test('validly signed but malformed event -> 400, nothing changes', async () => {
    const { c } = await acceptedEntry();
    for (const raw of ['not json', '{}', JSON.stringify({ id: 'e', type: 'post.exploded', data: {} })]) {
      const res = await send(raw, { 'x-signature': sign(raw, t.secrets.webhookSecret) });
      assert.equal(res.status, 400, raw);
    }
    assert.equal(await statusOf(c), 'publishing');
  });

  test('VALID webhook flips status to published (probe 4), and only then', async () => {
    const { c, entry } = await acceptedEntry();
    assert.equal(await statusOf(c), 'publishing', 'accepted by the platform is NOT published');
    const raw = JSON.stringify(event(entry));
    const res = await send(raw, { 'x-signature': sign(raw, t.secrets.webhookSecret) });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, applied: true, duplicate: false });
    const after = (await t.getCampaign(c.id)).variants[0].socialPost;
    assert.equal(after.status, 'published');
    assert.ok(after.publishedAt);
    assert.match(after.postUrl, /social\.example/);
  });

  test('a valid webhook can mark a post failed, with the platform reason recorded', async () => {
    const { c, entry } = await acceptedEntry();
    const raw = JSON.stringify(event(entry, 'post.failed'));
    assert.equal((await send(raw, { 'x-signature': sign(raw, t.secrets.webhookSecret) })).status, 200);
    const after = (await t.getCampaign(c.id)).variants[0].socialPost;
    assert.equal(after.status, 'failed');
    assert.equal(after.lastError, 'media_processing_failed');
  });

  test('at-least-once delivery: a duplicate event is de-duplicated; a late contradictory event cannot un-publish', async () => {
    const { c, entry } = await acceptedEntry();
    const raw = JSON.stringify(event(entry, 'post.published', 'evt_dup'));
    const headers = () => ({ 'x-signature': sign(raw, t.secrets.webhookSecret) });
    assert.equal((await (await send(raw, headers())).json()).duplicate, false);
    const second = await (await send(raw, headers())).json();
    assert.equal(second.duplicate, true);
    assert.equal(second.applied, false);

    const contradiction = JSON.stringify(event(entry, 'post.failed', 'evt_late'));
    const res = await send(contradiction, { 'x-signature': sign(contradiction, t.secrets.webhookSecret) });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).applied, false);
    assert.equal(await statusOf(c), 'published', 'terminal states are never overwritten');
  });

  test('authentic event for an unknown post is acknowledged (2xx) but ignored', async () => {
    const raw = JSON.stringify({ id: 'evt_x', type: 'post.published', data: { post_id: 'p', idempotency_key: 'studio-variant-424242', platform: 'x' } });
    const res = await send(raw, { 'x-signature': sign(raw, t.secrets.webhookSecret) });
    assert.equal(res.status, 202);
  });

  test('end to end with the REAL platform signing: release held webhooks -> published', async () => {
    const { c } = await acceptedEntry(['instagram']);
    await t.admin('/webhooks/hold', { hold: false });
    await t.admin('/webhooks/flush');
    await waitFor(async () => (await statusOf(c)) === 'published', { message: 'real signed webhook to land' });
    assert.equal(t.platform.state.stats.webhooksSent, 1);
  });

  test('the platform retries a webhook until the receiver acknowledges it', async () => {
    const c = await t.approvedCampaign(['x']);
    await t.admin('/webhooks/hold', { hold: false });
    // Point deliveries at a dead port first, then heal the URL: the platform must keep retrying.
    const goodUrl = t.platform.config.webhookUrl;
    await t.admin('/config', { webhookUrl: 'http://127.0.0.1:9/webhook/social-delivery' });
    await t.api('POST', `/api/campaigns/${c.id}/publish`, {});
    await t.tickAll();
    await waitFor(() => t.platform.state.stats.webhookFailures >= 1, { message: 'a failed delivery' });
    await t.admin('/config', { webhookUrl: goodUrl });
    await waitFor(async () => (await statusOf(c)) === 'published', { message: 'delivery on retry' });
  });
});

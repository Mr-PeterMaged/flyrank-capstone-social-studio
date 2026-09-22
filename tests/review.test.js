import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, SAMPLE_POST } from './helpers.js';

describe('review workflow, validation and auth', () => {
  let t;
  before(async () => {
    t = await setup();
  });
  after(() => t.teardown());

  async function freshCampaign(platforms = ['x']) {
    const post = (await t.api('POST', '/api/posts', SAMPLE_POST)).body;
    return (await t.api('POST', `/api/posts/${post.id}/campaigns`, { platforms })).body;
  }

  test('scheduling an UNAPPROVED variant is refused with 4xx and names the variant (probe 3)', async () => {
    const c = await freshCampaign();
    const res = await t.api('POST', `/api/campaigns/${c.id}/schedule`, { inSeconds: 60 });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'variant_not_approved');
    assert.equal(res.body.error.details.variants[0].reviewStatus, 'draft');
    assert.equal((await t.getCampaign(c.id)).variants[0].socialPost, null, 'nothing was created');
  });

  test('publish-now of an unapproved variant is refused too', async () => {
    const c = await freshCampaign();
    assert.equal((await t.api('POST', `/api/campaigns/${c.id}/publish`, {})).status, 409);
  });

  test('approved variant CAN be scheduled', async () => {
    const c = await freshCampaign();
    await t.api('POST', `/api/variants/${c.variants[0].id}/approve`);
    const res = await t.api('POST', `/api/campaigns/${c.id}/schedule`, { inSeconds: 3600 });
    assert.equal(res.status, 201);
    assert.equal(res.body.entries[0].status, 'queued');
  });

  test('all-or-nothing: one unapproved variant blocks the whole schedule request', async () => {
    const c = await freshCampaign(['x', 'instagram']);
    await t.api('POST', `/api/variants/${c.variants[0].id}/approve`);
    const res = await t.api('POST', `/api/campaigns/${c.id}/schedule`, { inSeconds: 60 });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.details.variants.length, 1);
    assert.ok((await t.getCampaign(c.id)).variants.every((v) => v.socialPost === null));
  });

  test('rejected variants cannot be approved or scheduled; approve is idempotent', async () => {
    const c = await freshCampaign();
    const id = c.variants[0].id;
    assert.equal((await t.api('POST', `/api/variants/${id}/approve`)).status, 200);
    assert.equal((await t.api('POST', `/api/variants/${id}/approve`)).status, 200);
    assert.equal((await t.api('POST', `/api/variants/${id}/reject`)).status, 200);
    assert.equal((await t.api('POST', `/api/variants/${id}/approve`)).status, 409);
    assert.equal((await t.api('POST', `/api/campaigns/${c.id}/schedule`, { inSeconds: 1 })).status, 409);
  });

  test('a scheduled variant cannot be rejected or edited', async () => {
    const c = await t.approvedCampaign(['x']);
    await t.api('POST', `/api/campaigns/${c.id}/schedule`, { inSeconds: 3600 });
    assert.equal((await t.api('POST', `/api/variants/${c.variants[0].id}/reject`)).status, 409);
    const edit = await t.api('PATCH', `/api/variants/${c.variants[0].id}`, { caption: 'New words https://example.com' });
    assert.equal(edit.status, 409);
  });

  test('bad input is a clean 4xx, never a 500', async () => {
    const cases = [
      ['POST', '/api/posts', {}, 400],
      ['POST', '/api/posts', { title: 'x', body: 'y', url: 'not-a-url' }, 400],
      ['POST', '/api/posts', { title: 'x', body: 'y', url: 'javascript:alert(1)' }, 400],
      ['POST', '/api/posts/abc/campaigns', {}, 400],
      ['POST', '/api/posts/999999/campaigns', {}, 404],
      ['POST', '/api/posts/1/campaigns', { platforms: ['myspace'] }, 400],
      ['POST', '/api/posts/1/campaigns', { platforms: ['x', 'x'] }, 400],
      ['GET', '/api/campaigns/999999', undefined, 404],
      ['POST', '/api/variants/999999/approve', undefined, 404],
      ['PATCH', '/api/variants/1', { caption: '' }, 400],
      ['POST', '/api/campaigns/1/schedule', {}, 400],
      ['POST', '/api/campaigns/1/schedule', { at: 'tomorrow' }, 400],
      ['POST', '/api/campaigns/1/schedule', { at: '2030-01-01T00:00:00Z', inSeconds: 5 }, 400],
      ['GET', '/api/nope', undefined, 404],
    ];
    for (const [method, url, body, want] of cases) {
      const r = await t.api(method, url, body);
      assert.equal(r.status, want, `${method} ${url} -> ${r.status} ${JSON.stringify(r.body)}`);
      assert.ok(r.body.error?.code, 'structured error body');
    }
  });

  test('malformed JSON is a 400', async () => {
    const res = await fetch(`${t.baseUrl}/api/posts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${t.secrets.apiKey}` },
      body: '{"title": ',
    });
    assert.equal(res.status, 400);
  });

  test('API requires the key; the wrong key is rejected', async () => {
    assert.equal((await t.api('GET', '/api/campaigns', undefined, { auth: false })).status, 401);
    const res = await fetch(`${t.baseUrl}/api/campaigns`, { headers: { authorization: 'Bearer wrong-key' } });
    assert.equal(res.status, 401);
  });

  test('a slot can be moved only until the first attempt', async () => {
    const c = await t.approvedCampaign(['x']);
    const first = await t.api('POST', `/api/campaigns/${c.id}/schedule`, { at: '2031-01-01T09:00:00Z' });
    assert.equal(first.status, 201);
    const moved = await t.api('POST', `/api/campaigns/${c.id}/schedule`, { at: '2031-01-02T09:00:00Z' });
    assert.equal(moved.body.entries[0].rescheduled, true);
    assert.equal(new Date(moved.body.entries[0].scheduledAt).toISOString(), '2031-01-02T09:00:00.000Z');
    assert.equal(moved.body.entries[0].id, first.body.entries[0].id, 'same row, not a second job');
  });
});

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { PLATFORMS } from '../src/content/platforms.js';
import { createPlaceholderSource, renderVariant, insideSafeZone } from '../src/content/images.js';
import { composeCaption, buildPrompt } from '../src/content/captions.js';
import { validateCaption, weightedLength } from '../src/content/validate.js';
import { brandVoice, platformFragments } from '../src/content/social-prompts.config.js';
import { setup, SAMPLE_POST } from './helpers.js';

describe('image variants', () => {
  const expected = { instagram: [1080, 1080], x: [1600, 900], linkedin: [1200, 627] };

  for (const [platform, [w, h]] of Object.entries(expected)) {
    test(`${platform}: ${w}x${h}, exact aspect ratio, subject inside the safe zone`, async () => {
      const source = await createPlaceholderSource(SAMPLE_POST.title);
      const out = await renderVariant(source, PLATFORMS[platform].image, 'Test Brand');
      const meta = await sharp(out.buffer).metadata();
      assert.equal(meta.width, w);
      assert.equal(meta.height, h);
      assert.equal(meta.format, 'png');
      assert.ok(Math.abs(meta.width / meta.height - w / h) < 1e-9, 'aspect ratio');
      assert.equal(out.safeZoneOk, true, 'subject must sit inside the safe zone');
      assert.equal(out.mode, 'crop');
    });
  }

  test('a naive centre crop would have clipped the off-centre subject; ours does not', async () => {
    const source = await createPlaceholderSource('Off centre subject');
    // Centre crop for 1:1 would be x in [400, 2000]; the subject spans x 1100..2100.
    const centreLeft = Math.round((source.width - source.height) / 2);
    assert.ok(source.subject.x + source.subject.width > centreLeft + source.height, 'fixture really is off-centre');
    const out = await renderVariant(source, PLATFORMS.instagram.image);
    assert.equal(out.safeZoneOk, true);
  });

  test('a subject too large for the safe zone falls back to contain instead of being cropped', async () => {
    const source = await createPlaceholderSource('Huge subject');
    source.subject = { x: 100, y: 100, width: 2200, height: 1400 }; // nearly the whole frame
    const out = await renderVariant(source, PLATFORMS.instagram.image);
    assert.equal(out.mode, 'contain');
    assert.equal(out.safeZoneOk, true);
    assert.equal((await sharp(out.buffer).metadata()).width, 1080);
  });

  test('insideSafeZone respects the margin', () => {
    assert.equal(insideSafeZone({ x: 100, y: 100, width: 800, height: 800 }, 1000, 1000, 0.1), true);
    assert.equal(insideSafeZone({ x: 50, y: 100, width: 800, height: 800 }, 1000, 1000, 0.1), false);
  });
});

describe('captions and constraint profiles', () => {
  test('captions differ per platform and each satisfies its own profile', () => {
    const caps = Object.fromEntries(Object.keys(PLATFORMS).map((p) => [p, composeCaption(p, SAMPLE_POST)]));
    assert.equal(new Set(Object.values(caps)).size, 3, 'three distinct captions');
    for (const [p, caption] of Object.entries(caps)) {
      assert.deepEqual(validateCaption(p, caption), [], `${p} caption must be valid:\n${caption}`);
    }
    assert.ok(weightedLength(caps.x, PLATFORMS.x.constraints) <= 280);
    assert.ok(!/https?:\/\//.test(caps.instagram), 'instagram has no links');
    assert.match(caps.x, /https:\/\/example\.com\/blog\/idempotency-keys/);
  });

  test('X still fits 280 for a very long title and body', () => {
    const post = { title: 'A '.repeat(200) + 'title', body: 'Lorem ipsum dolor. '.repeat(400), url: 'https://example.com/x' };
    assert.deepEqual(validateCaption('x', composeCaption('x', post)), []);
  });

  test('every rule is enforced and the error NAMES the broken rule', () => {
    const rules = (platform, text) => validateCaption(platform, text).map((v) => v.rule);
    assert.ok(rules('x', 'a'.repeat(281) + ' https://e.co').includes('max_length'));
    assert.ok(rules('x', 'hi https://e.co #a #b #c').includes('max_hashtags'));
    assert.ok(rules('instagram', 'see https://e.co #a').includes('urls_not_allowed'));
    assert.ok(rules('x', 'no link here').includes('url_required'));
    assert.ok(rules('linkedin', 'Wow! Amazing! https://e.co').includes('max_exclamations'));
    assert.ok(rules('linkedin', 'THIS is HUGE https://e.co').includes('max_all_caps_words'));
    assert.ok(rules('instagram', 'Please click here now').includes('banned_phrase'));
    assert.ok(rules('instagram', '   ').includes('empty'));
    const [v] = validateCaption('x', 'a'.repeat(300) + ' https://e.co');
    assert.match(v.message, /allows at most 280/);
  });

  test('X counts every URL as 23 characters', () => {
    const c = PLATFORMS.x.constraints;
    assert.equal(weightedLength('https://example.com/a-very-long-url-that-is-way-more-than-23-chars', c), 23);
    assert.equal(weightedLength('hi https://e.co', c), 3 + 23);
  });

  test('prompts are composed from shared + platform fragments, never duplicated', () => {
    const prompts = Object.keys(platformFragments).map((p) => buildPrompt(p, SAMPLE_POST));
    for (const p of prompts) assert.ok(p.includes(brandVoice.prompt), 'shared voice present in every prompt');
    const paragraphs = prompts.flatMap((p) => p.split('\n\n'));
    const shared = paragraphs.filter((x) => x === brandVoice.prompt);
    assert.equal(shared.length, prompts.length, 'voice appears exactly once per prompt');
    // platform rules differ, so no two prompts are near-identical copies
    const rulesLines = prompts.map((p) => p.split('\n\n')[1]);
    assert.equal(new Set(rulesLines).size, prompts.length);
  });
});

describe('campaign generation through the API', () => {
  let t;
  before(async () => {
    t = await setup();
  });
  after(() => t.teardown());

  test('artifacts on disk: correct files, dimensions and distinct captions (probe 5)', async () => {
    const post = (await t.api('POST', '/api/posts', SAMPLE_POST)).body;
    const res = await t.api('POST', `/api/posts/${post.id}/campaigns`, {});
    assert.equal(res.status, 201);
    const byPlatform = Object.fromEntries(res.body.variants.map((v) => [v.platform, v]));
    const dims = { instagram: [1080, 1080], x: [1600, 900], linkedin: [1200, 627] };
    for (const [p, [w, h]] of Object.entries(dims)) {
      const file = path.join(t.config.artifactDir, byPlatform[p].imagePath);
      assert.ok(fs.existsSync(file), `${p} file exists`);
      const meta = await sharp(file).metadata();
      assert.deepEqual([meta.width, meta.height], [w, h], `${p} dimensions`);
      assert.equal(byPlatform[p].reviewStatus, 'draft');
    }
    assert.equal(new Set(res.body.variants.map((v) => v.caption)).size, 3);
    // and the image is actually served
    const img = await fetch(`${t.baseUrl}${byPlatform.x.imageUrl}`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
  });

  test('a human caption that breaks a rule is refused with the rule named (probe 2)', async () => {
    const post = (await t.api('POST', '/api/posts', SAMPLE_POST)).body;
    const res = await t.api('POST', `/api/posts/${post.id}/campaigns`, {
      platforms: ['x'],
      captions: { x: 'z'.repeat(400) + ' https://example.com' },
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'constraint_violation');
    assert.equal(res.body.error.details.violations.x[0].rule, 'max_length');
    assert.match(res.body.error.details.violations.x[0].message, /280/);
  });

  test('editing a caption re-validates; bad edits are refused, good edits stay draft', async () => {
    const c = await t.approvedCampaign(['x']).catch(() => null);
    assert.ok(c);
    const post = (await t.api('POST', '/api/posts', SAMPLE_POST)).body;
    const created = (await t.api('POST', `/api/posts/${post.id}/campaigns`, { platforms: ['x'] })).body;
    const vid = created.variants[0].id;
    const bad = await t.api('PATCH', `/api/variants/${vid}`, { caption: 'no link and #a #b #c' });
    assert.equal(bad.status, 422);
    assert.deepEqual(bad.body.error.details.violations.map((v) => v.rule).sort(), ['max_hashtags', 'url_required']);
    const good = await t.api('PATCH', `/api/variants/${vid}`, { caption: 'Retries made safe. https://example.com/x #Retries' });
    assert.equal(good.status, 200);
    assert.equal(good.body.reviewStatus, 'draft');
  });
});

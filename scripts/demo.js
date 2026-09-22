// Scripted walkthrough of the 6-minute demo (brief section 13). Needs `npm start` running.
//   npm run demo
import path from 'node:path';
import sharp from 'sharp';
import { loadDotEnv, loadConfig } from '../src/config.js';
import { sign } from '../src/lib/webhookSignature.js';

loadDotEnv();
const cfg = loadConfig();
const APP = `http://localhost:${cfg.port}`;
const PLATFORM = cfg.platform.baseUrl;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, url, body) {
  const res = await fetch(APP + url, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const platformAdmin = (p, body) =>
  fetch(`${PLATFORM}/_admin${p}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());

const step = (n, t) => console.log(`\n\x1b[1;32m== ${n}. ${t}\x1b[0m`);
const say = (m) => console.log('   ' + m);

async function waitFor(fn, what, timeout = 30_000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timed out: ${what}`);
    await sleep(400);
  }
}
const campaign = async (id) => (await api('GET', `/api/campaigns/${id}`)).body;
const statuses = async (id) => (await campaign(id)).variants.map((v) => `${v.platform}=${v.socialPost?.status ?? '-'}`).join('  ');

async function newCampaign(platforms, n = 0) {
  const post = (
    await api('POST', '/api/posts', {
      title: `Demo post ${Date.now() % 100000}-${n}: retries without regret`,
      url: 'https://example.com/blog/retries-without-regret',
      body: 'Retries are only safe when the operation is idempotent. Attach a key, store it, resend it. The server does the rest.',
    })
  ).body;
  const c = (await api('POST', `/api/posts/${post.id}/campaigns`, platforms ? { platforms } : {})).body;
  for (const v of c.variants) await api('POST', `/api/variants/${v.id}/approve`);
  return c;
}

try {
  await fetch(`${PLATFORM}/health`);
} catch {
  console.error('Fake platform is not reachable. Run `npm start` first.');
  process.exit(1);
}
await platformAdmin('/reset', {});
await platformAdmin('/webhooks/hold', { hold: false });

// ------------------------------------------------------------------ 1-2
step(1, 'Create a campaign from a blog post');
const post = (
  await api('POST', '/api/posts', {
    title: 'Why Idempotency Keys Make Retries Safe',
    url: 'https://example.com/blog/idempotency-keys',
    body: 'Networks fail. A retry after a timeout is dangerous when the first request actually succeeded. An idempotency key lets the server recognise the repeat and return the original result instead of doing the work twice.',
  })
).body;
const c1 = (await api('POST', `/api/posts/${post.id}/campaigns`, {})).body;
step(2, 'Generated images + platform-specific captions');
for (const v of c1.variants) {
  const meta = await sharp(path.join(cfg.artifactDir, v.imagePath)).metadata();
  say(`${v.platform.padEnd(9)} ${meta.width}x${meta.height}  ${v.reviewStatus}`);
  say(`          ${v.caption.split('\n').filter(Boolean).slice(0, 2).join(' | ').slice(0, 110)}`);
}
say('Unapproved schedule attempt ->');
const refused = await api('POST', `/api/campaigns/${c1.id}/schedule`, { inSeconds: 5 });
say(`HTTP ${refused.status} ${refused.body.error?.code}: ${refused.body.error?.message}`);
for (const v of c1.variants) await api('POST', `/api/variants/${v.id}/approve`);

// ------------------------------------------------------------------ 3
step(3, 'Schedule for "tomorrow 09:00", advance time, watch the worker publish');
const clock = (await api('GET', '/api/admin/clock')).body;
const at = new Date(Date.parse(clock.schedulerNow) + 24 * 3600_000).toISOString();
await api('POST', `/api/campaigns/${c1.id}/schedule`, { at });
say(`scheduled for ${at}; status: ${await statuses(c1.id)}`);
await sleep(2500);
say(`2.5s later, still not due:  ${await statuses(c1.id)}`);
await api('POST', '/api/admin/clock/advance', { seconds: 24 * 3600 + 1 });
say('clock advanced by 24h ...');
await waitFor(async () => (await campaign(c1.id)).status === 'published', 'campaign published');
say(`published:  ${await statuses(c1.id)}`);
await api('POST', '/api/admin/clock/reset');

// ------------------------------------------------------------------ 4
step(4, 'Idempotency: hammer publish 5x (and lose the first response)');
const c2 = await newCampaign(['x', 'instagram'], 2);
await platformAdmin('/webhooks/hold', { hold: true }); // keep "accepted, unconfirmed" visible
await platformAdmin('/faults', { faults: ['timeout_after_accept', 'timeout_after_accept'] });
const hits = await Promise.all(Array.from({ length: 5 }, () => api('POST', `/api/campaigns/${c2.id}/publish`, {})));
say(`5 requests -> HTTP ${hits.map((h) => h.status).join(', ')} (one creates, the rest are replays)`);
await waitFor(async () => (await campaign(c2.id)).variants.every((v) => v.socialPost?.platformPostId), 'retries to converge', 45_000);
say(`after timeout + retries:  ${await statuses(c2.id)}   <- accepted, but NOT published until a signed webhook`);
await platformAdmin('/webhooks/hold', { hold: false });
await platformAdmin('/webhooks/flush', {});
await waitFor(async () => (await campaign(c2.id)).status === 'published', 'c2 published');
const keys = new Set(c2.variants.map((v) => `studio-variant-${v.id}`));
const onPlatform = (await platformAdmin('/posts')).filter((p) => keys.has(p.idempotencyKey));
const stats = await platformAdmin('/stats');
say(`posts that exist on the platform for this campaign: ${onPlatform.length} (expected ${c2.variants.length})`);
say(`platform saw ${stats.replays} idempotent replay(s) - retries after the timeout were recognised`);

// ------------------------------------------------------------------ 5
step(5, 'Rate limit: 429 Retry-After: 3');
const c3 = await newCampaign(['linkedin'], 3);
await platformAdmin('/rate-limit', { retryAfter: 3, platform: 'linkedin' });
const t0 = Date.now();
await api('POST', `/api/campaigns/${c3.id}/publish`, {});
await waitFor(async () => (await campaign(c3.id)).variants[0].socialPost?.lastError?.includes('rate_limited'), 'a 429');
say(`429 received; worker parked the job:  ${(await campaign(c3.id)).variants[0].socialPost.lastError}`);
await waitFor(async () => (await campaign(c3.id)).status === 'published', 'c3 published');
const s2 = await platformAdmin('/stats');
say(`published after ${((Date.now() - t0) / 1000).toFixed(1)}s; requests sent during the Retry-After window: ${s2.violations} (0 = not hammered)`);

// ------------------------------------------------------------------ 6
step(6, 'Webhook trust: forged -> 400, signed -> published');
const c4 = await newCampaign(['x'], 4);
await platformAdmin('/webhooks/hold', { hold: true });
await api('POST', `/api/campaigns/${c4.id}/publish`, {});
const entry = await waitFor(async () => {
  const e = (await campaign(c4.id)).variants[0].socialPost;
  return e?.platformPostId ? e : null;
}, 'platform to accept');
say(`platform accepted the post; our status is still "${entry.status}" (waiting for a verified webhook)`);
const evt = JSON.stringify({
  id: 'evt_demo_forged',
  type: 'post.published',
  data: { post_id: entry.platformPostId, idempotency_key: entry.idempotencyKey, platform: 'x', url: 'https://evil.example/p/1' },
});
const send = (raw, sig) => fetch(`${APP}/webhook/social-delivery`, { method: 'POST', headers: { 'content-type': 'application/json', ...(sig ? { 'x-signature': sig } : {}) }, body: raw });
const forged = await send(evt, sign(evt, 'not-the-real-secret'));
say(`forged webhook  -> HTTP ${forged.status}; status now: ${(await campaign(c4.id)).variants[0].socialPost.status}`);
const good = JSON.stringify({ ...JSON.parse(evt), id: 'evt_demo_valid', data: { ...JSON.parse(evt).data, url: entry.postUrl ?? `${PLATFORM}/p/${entry.platformPostId}` } });
const valid = await send(good, sign(good, cfg.webhook.secret));
say(`signed webhook  -> HTTP ${valid.status}; status now: ${(await campaign(c4.id)).variants[0].socialPost.status}`);
await platformAdmin('/webhooks/hold', { hold: false });

step(7, 'Dashboard');
say(`Open ${APP} (API key = API_KEY from .env). Every post above was created on the FAKE platform; no real account was touched.`);

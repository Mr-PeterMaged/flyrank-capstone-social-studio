// Fake social platform. Deliberately independent of ../src: it is a different company's
// server, so it carries its own copy of the platform rules and its own HMAC signing.
//
// What it simulates (everything the publisher must survive):
//   - OAuth client-credentials -> short-lived bearer tokens (401 when expired/revoked)
//   - POST /v1/:platform/posts with Idempotency-Key (replay => same post, never a second)
//   - 429 + Retry-After (seconds or HTTP-date), and it COUNTS clients that ignore it
//   - one-shot faults: 500s, "accepted but the response never arrives" (the nasty timeout)
//   - asynchronous, HMAC-signed delivery webhooks with at-least-once retries
//   - media validation (exact pixel dimensions per platform)
import express from 'express';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';

const SPECS = {
  instagram: { width: 1080, height: 1080, maxCaption: 2200 },
  x: { width: 1600, height: 900, maxCaption: 280, urlWeight: 23 },
  linkedin: { width: 1200, height: 627, maxCaption: 3000 },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rid = (prefix) => `${prefix}_${crypto.randomBytes(8).toString('hex')}`;

function signBody(rawBody, secret, t = Math.floor(Date.now() / 1000)) {
  const v1 = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

function weightedLength(text, spec) {
  if (!spec.urlWeight) return [...text].length;
  const urls = text.match(/https?:\/\/\S+/g) ?? [];
  return [...urls.reduce((t, u) => t.replace(u, ''), text)].length + urls.length * spec.urlWeight;
}

export function createFakePlatform(options = {}) {
  const config = {
    port: 4010,
    publicUrl: undefined,
    clientId: 'studio-app',
    clientSecret: 'secret',
    webhookUrl: 'http://localhost:3100/webhook/social-delivery',
    webhookSecret: 'whsec',
    tokenTtlSec: 3600,
    webhookDelayMs: 300,
    publishFailRate: 0, // random 500s before a post is accepted
    deliveryFailRate: 0, // share of accepted posts that later end as post.failed
    hangMs: 6000, // how long a "timeout" fault sits on the response
    webhookRetries: 4,
    webhookRetryDelayMs: 400,
    hold: false, // when true, delivery webhooks queue up until flushed
    ...options,
  };

  const state = {
    tokens: new Map(), // token -> { platform, expiresAt }
    posts: new Map(), // id -> post
    byKey: new Map(), // `${platform}:${key}` -> { id, bodyHash }
    rate: new Map(), // platform -> { armedSec, httpDate, blockedUntil }  (limits are per platform)
    faults: [],
    held: [],
    timers: new Set(),
    stats: {
      publishRequests: 0,
      created: 0,
      replays: 0,
      rateLimited: 0,
      violations: 0, // requests that arrived while a Retry-After window was still open
      tokensIssued: 0,
      webhooksSent: 0,
      webhookFailures: 0,
    },
  };

  const app = express();
  app.use(express.json({ limit: '15mb' }));
  app.use(express.urlencoded({ extended: false }));

  app.get('/health', (_req, res) => res.json({ ok: true, service: 'fake-platform' }));

  // ---------------------------------------------------------------- OAuth
  app.post('/oauth/token', (req, res) => {
    const { grant_type, client_id, client_secret, scope } = req.body ?? {};
    if (grant_type !== 'client_credentials') return res.status(400).json({ error: 'unsupported_grant_type' });
    if (client_id !== config.clientId || client_secret !== config.clientSecret) {
      return res.status(401).json({ error: 'invalid_client' });
    }
    if (!SPECS[scope]) return res.status(400).json({ error: 'invalid_scope', message: `scope must be one of ${Object.keys(SPECS)}` });
    const token = `fpt_${crypto.randomBytes(24).toString('hex')}`;
    state.tokens.set(token, { platform: scope, expiresAt: Date.now() + config.tokenTtlSec * 1000 });
    state.stats.tokensIssued++;
    res.json({ access_token: token, token_type: 'Bearer', expires_in: config.tokenTtlSec, scope });
  });

  // ---------------------------------------------------------------- Publish
  app.post('/v1/:platform/posts', async (req, res) => {
    state.stats.publishRequests++;
    const { platform } = req.params;
    const spec = SPECS[platform];
    if (!spec) return res.status(404).json({ error: 'unknown_platform' });

    // 1. auth
    const bearer = /^Bearer (.+)$/.exec(req.get('authorization') ?? '')?.[1];
    const tok = bearer && state.tokens.get(bearer);
    if (!tok || tok.expiresAt <= Date.now()) return res.status(401).json({ error: 'invalid_token' });
    if (tok.platform !== platform) return res.status(403).json({ error: 'wrong_scope' });

    // 2. rate limit (before anything else, like a real API gateway)
    const now = Date.now();
    const rate = rateOf(platform);
    if (now < rate.blockedUntil) {
      state.stats.violations++;
      state.stats.rateLimited++;
      return rateLimited(res, rate, rate.blockedUntil - now);
    }
    if (rate.armedSec > 0) {
      rate.blockedUntil = now + rate.armedSec * 1000;
      rate.armedSec = 0;
      state.stats.rateLimited++;
      return rateLimited(res, rate, rate.blockedUntil - now);
    }

    // 3. idempotency
    const key = req.get('idempotency-key');
    if (!key) return res.status(400).json({ error: 'idempotency_key_required' });
    const bodyHash = crypto.createHash('sha256').update(JSON.stringify(req.body ?? {})).digest('hex');
    const seen = state.byKey.get(`${platform}:${key}`);
    if (seen) {
      if (seen.bodyHash !== bodyHash) return res.status(422).json({ error: 'idempotency_key_reuse', message: 'Key was used with a different payload' });
      state.stats.replays++;
      res.set('Idempotent-Replayed', 'true');
      return res.status(200).json(publicPost(state.posts.get(seen.id)));
    }

    // 4. one-shot faults that strike BEFORE the post is accepted
    const fault = state.faults[0];
    if (fault === 'error_500' || (!fault && Math.random() < config.publishFailRate)) {
      if (fault) state.faults.shift();
      return res.status(500).json({ error: 'internal_error' });
    }
    if (fault === 'timeout_before_accept') {
      state.faults.shift();
      await sleep(config.hangMs);
      return; // nothing was stored; the client has long since given up
    }

    // 5. validate payload against the platform's rules
    const { caption, image } = req.body ?? {};
    if (typeof caption !== 'string' || !caption.trim()) return res.status(422).json({ error: 'caption_required' });
    if (weightedLength(caption, spec) > spec.maxCaption) return res.status(422).json({ error: 'caption_too_long', max: spec.maxCaption });
    const dims = readPngSize(image?.base64);
    if (!dims) return res.status(422).json({ error: 'image_required', message: 'image.base64 must be a PNG' });
    if (dims.width !== spec.width || dims.height !== spec.height) {
      return res.status(422).json({ error: 'bad_image_dimensions', expected: `${spec.width}x${spec.height}`, got: `${dims.width}x${dims.height}` });
    }

    // 6. accept: from here on the post EXISTS on the platform, whatever happens next
    if (fault === 'timeout_after_accept') state.faults.shift();
    const id = rid('post');
    const base = config.publicUrl ?? `http://localhost:${config.port}`;
    const post = { id, platform, caption, idempotencyKey: key, status: 'accepted', url: `${base}/p/${id}`, createdAt: new Date().toISOString() };
    state.posts.set(id, post);
    state.byKey.set(`${platform}:${key}`, { id, bodyHash });
    state.stats.created++;
    scheduleDelivery(post);

    if (fault === 'timeout_after_accept') {
      // The dangerous case: accepted, stored, but the answer never reaches the client.
      await sleep(config.hangMs);
      return;
    }
    res.status(201).json(publicPost(post));
  });

  app.get('/p/:id', (req, res) => {
    const p = state.posts.get(req.params.id);
    return p ? res.json(publicPost(p)) : res.status(404).json({ error: 'not_found' });
  });

  function rateOf(platform) {
    if (!state.rate.has(platform)) state.rate.set(platform, { armedSec: 0, httpDate: false, blockedUntil: 0 });
    return state.rate.get(platform);
  }

  function rateLimited(res, rate, remainingMs) {
    const secs = Math.max(1, Math.ceil(remainingMs / 1000));
    res.set('Retry-After', rate.httpDate ? new Date(Date.now() + secs * 1000).toUTCString() : String(secs));
    return res.status(429).json({ error: 'rate_limited', retry_after: secs });
  }

  const publicPost = (p) => ({ id: p.id, platform: p.platform, status: p.status, url: p.url, created_at: p.createdAt });

  // ---------------------------------------------------------------- Webhooks
  function scheduleDelivery(post, forcedOutcome) {
    const run = () => deliver(post, forcedOutcome);
    if (config.hold) return state.held.push(run);
    const t = setTimeout(() => {
      state.timers.delete(t);
      run();
    }, config.webhookDelayMs);
    state.timers.add(t);
  }

  async function deliver(post, forcedOutcome) {
    const outcome = forcedOutcome ?? (Math.random() < config.deliveryFailRate ? 'failed' : 'published');
    post.status = outcome;
    const event = {
      id: `evt_${post.id}_${outcome}`, // stable across retries so receivers can de-duplicate
      type: `post.${outcome}`,
      created: Math.floor(Date.now() / 1000),
      data: {
        post_id: post.id,
        idempotency_key: post.idempotencyKey,
        platform: post.platform,
        url: post.url,
        ...(outcome === 'failed' ? { reason: 'media_processing_failed' } : {}),
      },
    };
    const rawBody = JSON.stringify(event);
    for (let attempt = 1; attempt <= config.webhookRetries; attempt++) {
      try {
        const r = await fetch(config.webhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-signature': signBody(rawBody, config.webhookSecret) },
          body: rawBody,
          signal: AbortSignal.timeout(3000),
        });
        if (r.ok) {
          state.stats.webhooksSent++;
          return;
        }
      } catch {
        /* receiver down: retry below */
      }
      state.stats.webhookFailures++;
      await sleep(config.webhookRetryDelayMs * attempt);
    }
  }

  // ---------------------------------------------------------------- Admin / chaos controls
  const admin = express.Router();
  admin.get('/posts', (_req, res) => res.json([...state.posts.values()]));
  admin.get('/stats', (_req, res) => res.json({ ...state.stats, posts: state.posts.size, faultsPending: state.faults.length }));
  admin.post('/config', (req, res) => {
    for (const k of ['webhookDelayMs', 'publishFailRate', 'deliveryFailRate', 'hangMs', 'tokenTtlSec', 'webhookUrl']) {
      if (req.body?.[k] !== undefined) config[k] = req.body[k];
    }
    res.json({ ok: true });
  });
  // {retryAfter: 30, platform?: "x", httpDate?: true} -> the NEXT publish request to that
  // platform (default: every platform) gets 429 Retry-After: 30 and the platform stays
  // closed for that window; requests arriving early are counted as violations.
  admin.post('/rate-limit', (req, res) => {
    const secs = Number(req.body?.retryAfter ?? 30);
    const targets = req.body?.platform ? [req.body.platform] : Object.keys(SPECS);
    if (!targets.every((p) => SPECS[p])) return res.status(400).json({ error: 'unknown_platform' });
    for (const p of targets) Object.assign(rateOf(p), { armedSec: secs, httpDate: Boolean(req.body?.httpDate) });
    res.json({ ok: true, armed: secs, platforms: targets });
  });
  admin.post('/faults', (req, res) => {
    const allowed = new Set(['error_500', 'timeout_after_accept', 'timeout_before_accept']);
    const list = Array.isArray(req.body?.faults) ? req.body.faults : [];
    if (!list.every((f) => allowed.has(f))) return res.status(400).json({ error: 'unknown_fault', allowed: [...allowed] });
    state.faults.push(...list);
    res.json({ ok: true, queue: state.faults });
  });
  admin.post('/tokens/revoke', (_req, res) => {
    state.tokens.clear();
    res.json({ ok: true });
  });
  admin.post('/webhooks/hold', (req, res) => {
    config.hold = Boolean(req.body?.hold);
    res.json({ ok: true, hold: config.hold });
  });
  admin.post('/webhooks/flush', async (_req, res) => {
    const runs = state.held.splice(0);
    await Promise.all(runs.map((r) => r()));
    res.json({ ok: true, delivered: runs.length });
  });
  admin.post('/posts/:id/deliver', async (req, res) => {
    const p = state.posts.get(req.params.id);
    if (!p) return res.status(404).json({ error: 'not_found' });
    await deliver(p, req.body?.outcome === 'failed' ? 'failed' : 'published');
    res.json({ ok: true });
  });
  // Clears posts, faults, limits and counters. Tokens survive (use /tokens/revoke for that).
  admin.post('/reset', (_req, res) => {
    state.posts.clear();
    state.byKey.clear();
    state.faults.length = 0;
    state.held.length = 0;
    state.rate.clear();
    Object.keys(state.stats).forEach((k) => (state.stats[k] = 0));
    res.json({ ok: true });
  });
  app.use('/_admin', admin);

  let server;
  return {
    app,
    state,
    config,
    start() {
      return new Promise((resolve) => {
        server = app.listen(config.port, () => {
          config.port = server.address().port;
          resolve(config.port);
        });
      });
    },
    stop() {
      for (const t of state.timers) clearTimeout(t);
      return new Promise((resolve) => {
        if (!server) return resolve();
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}

function readPngSize(b64) {
  if (typeof b64 !== 'string') return null;
  const buf = Buffer.from(b64, 'base64');
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(sig)) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// Run standalone: `node fakeplatform/server.js`
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    if (fs.existsSync('.env')) process.loadEnvFile('.env');
  } catch {
    /* ignore */
  }
  const e = process.env;
  const p = createFakePlatform({
    port: Number(e.PLATFORM_PORT ?? 4010),
    clientId: e.PLATFORM_CLIENT_ID ?? 'studio-app',
    clientSecret: e.PLATFORM_CLIENT_SECRET ?? 'secret',
    webhookUrl: e.WEBHOOK_URL ?? 'http://localhost:3100/webhook/social-delivery',
    webhookSecret: e.WEBHOOK_SECRET ?? 'whsec',
    publishFailRate: Number(e.PLATFORM_FAIL_RATE ?? 0),
  });
  p.start().then((port) => console.log(JSON.stringify({ level: 'info', msg: 'fake platform listening', port })));
}

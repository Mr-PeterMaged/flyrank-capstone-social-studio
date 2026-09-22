import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { createContainer } from '../src/container.js';
import { createApp } from '../src/http/app.js';
import { createFakePlatform } from '../fakeplatform/server.js';
import { setLogSink } from '../src/lib/logger.js';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, { timeout = 8000, interval = 50, message = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${message}`);
    await sleep(interval);
  }
}

export const SAMPLE_POST = {
  title: 'Why Idempotency Keys Make Retries Safe',
  body:
    '# Retries\n\nNetworks fail. **A retry after a timeout** is dangerous when the first request actually succeeded. ' +
    'An idempotency key lets the server recognise the repeat and return the original result instead of doing the work twice. ' +
    'Generate the key once, store it with the job, and send it on every attempt. That single habit prevents duplicate charges, ' +
    'duplicate emails and duplicate posts. See the [docs](https://example.com/docs) for details.',
  url: 'https://example.com/blog/idempotency-keys',
};

/**
 * Boots a fully wired system in-process: fake platform + app (+ optional worker loop)
 * on ephemeral ports, with a throwaway data directory. Everything is real; only the
 * ports and the timings (short) differ from production.
 */
export async function setup({ platform: platformOpts = {}, config: configOverrides = {}, silenceLogs = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-test-'));
  const secrets = {
    apiKey: crypto.randomBytes(16).toString('hex'),
    encKey: crypto.randomBytes(32).toString('base64'),
    clientSecret: crypto.randomBytes(16).toString('hex'),
    webhookSecret: crypto.randomBytes(16).toString('hex'),
  };
  const logs = [];
  setLogSink((line) => {
    logs.push(line);
    if (!silenceLogs) console.log(line);
  });

  const platform = createFakePlatform({
    port: 0,
    clientId: 'studio-app',
    clientSecret: secrets.clientSecret,
    webhookSecret: secrets.webhookSecret,
    webhookDelayMs: 30,
    webhookRetryDelayMs: 30,
    hangMs: 1500,
    ...platformOpts,
  });
  await platform.start();

  const env = {
    DATA_DIR: dir,
    API_KEY: secrets.apiKey,
    TOKEN_ENCRYPTION_KEY: secrets.encKey,
    PLATFORM_BASE_URL: `http://127.0.0.1:${platform.config.port}`,
    PLATFORM_CLIENT_ID: 'studio-app',
    PLATFORM_CLIENT_SECRET: secrets.clientSecret,
    PLATFORM_TIMEOUT_MS: '600',
    WEBHOOK_SECRET: secrets.webhookSecret,
    ENABLE_DEMO_CONTROLS: 'true',
    WORKER_POLL_MS: '50',
    WORKER_LEASE_MS: '1000',
    BACKOFF_BASE_MS: '40',
    BACKOFF_MAX_MS: '400',
    MAX_ATTEMPTS: '6',
    ...configOverrides,
  };
  const config = loadConfig(env);
  const container = createContainer(config);
  const app = createApp(container);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const appPort = server.address().port;
  const baseUrl = `http://127.0.0.1:${appPort}`;
  platform.config.webhookUrl = `${baseUrl}/webhook/social-delivery`;

  async function api(method, url, body, { auth = true } = {}) {
    const res = await fetch(baseUrl + url, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(auth ? { authorization: `Bearer ${secrets.apiKey}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, body: json, headers: res.headers };
  }

  const admin = (p, body = {}) =>
    fetch(`http://127.0.0.1:${platform.config.port}/_admin${p}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json());

  /** post -> campaign (all platforms) -> approve every variant. Returns the campaign. */
  async function approvedCampaign(platforms, postOverrides = {}) {
    const post = (await api('POST', '/api/posts', { ...SAMPLE_POST, ...postOverrides })).body;
    const created = await api('POST', `/api/posts/${post.id}/campaigns`, platforms ? { platforms } : {});
    for (const v of created.body.variants) {
      const r = await api('POST', `/api/variants/${v.id}/approve`);
      if (r.status !== 200) throw new Error(`approve failed: ${JSON.stringify(r.body)}`);
    }
    return created.body;
  }

  const getCampaign = async (id) => (await api('GET', `/api/campaigns/${id}`)).body;
  const statuses = async (id) => Object.fromEntries((await getCampaign(id)).variants.map((v) => [v.platform, v.socialPost?.status ?? null]));
  const tickAll = async () => {
    let n = 0;
    let c;
    while ((c = await container.worker.tick()) > 0) n += c;
    return n;
  };

  async function teardown() {
    await container.worker.stop();
    await new Promise((r) => {
      server.closeAllConnections?.();
      server.close(r);
    });
    await platform.stop();
    container.close();
    setLogSink((line) => process.stdout.write(line + '\n'));
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }

  return { dir, env, secrets, logs, platform, admin, config, container, baseUrl, api, approvedCampaign, getCampaign, statuses, tickAll, teardown };
}

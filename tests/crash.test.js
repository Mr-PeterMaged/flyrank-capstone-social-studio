import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setup, waitFor } from './helpers.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// PROBE 3: "Schedule a post, kill the worker mid-batch, restart it -> publishing completes
// with zero duplicates." These tests use REAL worker processes and really kill them.
describe('crash recovery with real worker processes (probe 3)', () => {
  let t;
  const children = [];

  before(async () => {
    t = await setup();
  });
  after(async () => {
    for (const c of children) c.kill();
    await Promise.all(children.map((c) => c.exited));
    await t.teardown();
  });
  beforeEach(async () => {
    await t.admin('/reset');
    await t.admin('/webhooks/hold', { hold: true });
  });

  function startWorker(extraEnv = {}) {
    const child = spawn(process.execPath, ['src/worker.js'], {
      cwd: ROOT,
      env: { ...process.env, ...t.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.output = '';
    child.stdout.on('data', (d) => (child.output += d));
    child.stderr.on('data', (d) => (child.output += d));
    child.exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
    children.push(child);
    return child;
  }

  const entries = async (id) => (await t.getCampaign(id)).variants.map((v) => v.socialPost);

  test('worker dies right AFTER the platform accepted, BEFORE it recorded that: restart -> zero duplicates', async () => {
    const c = await t.approvedCampaign();
    await t.api('POST', `/api/campaigns/${c.id}/publish`, {});

    const crashing = startWorker({ FAULT_CRASH_AFTER_ACCEPT: '1' });
    const { code, signal } = await crashing.exited;
    assert.ok(code !== 0 || signal, `worker should have died abnormally (code=${code}): ${crashing.output}`);
    assert.match(crashing.output, /simulating crash/);

    // State after the crash: at least one post really exists on the platform, yet our DB
    // never learned about it - the exact window that causes duplicates in naive systems.
    const created = t.platform.state.stats.created;
    assert.ok(created >= 1, 'platform accepted at least one post before the crash');
    const stuck = (await entries(c.id)).filter((e) => e.status === 'publishing' && !e.platformPostId);
    assert.ok(stuck.length >= 1, 'a job is stranded: locked, unconfirmed');

    // Restart. The stranded job(s) are reclaimed once the lease (1s) expires.
    const healthy = startWorker();
    await waitFor(async () => (await entries(c.id)).every((e) => e.platformPostId), { timeout: 15_000, message: 'restarted worker to finish' });
    healthy.kill();

    assert.equal(t.platform.state.posts.size, 3, 'exactly one post per platform');
    assert.equal(t.platform.state.stats.created, 3, 'the platform created each post ONCE');
    assert.ok(t.platform.state.stats.replays >= 1, 'the re-attempt was recognised by its idempotency key');
    const platforms = [...t.platform.state.posts.values()].map((p) => p.platform).sort();
    assert.deepEqual(platforms, ['instagram', 'linkedin', 'x']);

    // ...and the verified webhooks then confirm every one of them.
    await t.admin('/webhooks/hold', { hold: false });
    await t.admin('/webhooks/flush');
    await waitFor(async () => (await entries(c.id)).every((e) => e.status === 'published'), { message: 'webhooks' });
  });

  test('worker is hard-KILLED mid-publish (in flight to a slow platform): restart -> zero duplicates', async () => {
    const c = await t.approvedCampaign();
    // Every first publish is accepted by the platform but the answer hangs, keeping the worker busy.
    await t.admin('/faults', { faults: ['timeout_after_accept', 'timeout_after_accept', 'timeout_after_accept'] });
    await t.api('POST', `/api/campaigns/${c.id}/publish`, {});

    const victim = startWorker();
    await waitFor(() => t.platform.state.stats.created >= 3, { timeout: 10_000, message: 'platform to accept all three' });
    victim.kill(); // SIGKILL-equivalent: no cleanup, no graceful shutdown
    await victim.exited;

    const survivors = await entries(c.id);
    assert.ok(survivors.every((e) => !e.platformPostId), 'the DB never heard back from the platform');

    const healthy = startWorker();
    await waitFor(async () => (await entries(c.id)).every((e) => e.platformPostId), { timeout: 15_000, message: 'restart to finish' });
    healthy.kill();

    assert.equal(t.platform.state.posts.size, 3);
    assert.equal(t.platform.state.stats.created, 3, 'still exactly three posts after kill + restart');
    assert.ok(t.platform.state.stats.replays >= 3);
  });

  test('two live worker processes on one database: each job published exactly once', async () => {
    const c = await t.approvedCampaign();
    const a = startWorker({ WORKER_ID: 'proc-a', WORKER_BATCH_SIZE: '1' });
    const b = startWorker({ WORKER_ID: 'proc-b', WORKER_BATCH_SIZE: '1' });
    await t.api('POST', `/api/campaigns/${c.id}/publish`, {});
    await waitFor(async () => (await entries(c.id)).every((e) => e.platformPostId), { timeout: 15_000 });
    a.kill();
    b.kill();
    assert.equal(t.platform.state.stats.created, 3);
    assert.equal(t.platform.state.stats.publishRequests, 3, 'no job was attempted twice');
  });
});

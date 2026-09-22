import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { encrypt, decrypt, parseKey } from '../src/lib/crypto.js';
import { sign, verify } from '../src/lib/webhookSignature.js';
import { parseRetryAfter, backoffMs } from '../src/lib/retry.js';
import { addSecret, log, setLogSink } from '../src/lib/logger.js';

const KEY = crypto.randomBytes(32);

describe('token encryption (AES-256-GCM)', () => {
  test('round-trips', () => {
    assert.equal(decrypt(encrypt('fpt_secret_token', KEY, 'x'), KEY, 'x'), 'fpt_secret_token');
  });

  test('a fresh random IV every time: same plaintext never produces the same ciphertext', () => {
    const seen = new Set();
    const ivs = new Set();
    for (let i = 0; i < 200; i++) {
      const c = encrypt('same-plaintext', KEY, 'x');
      seen.add(c);
      ivs.add(c.split('.')[1]);
    }
    assert.equal(seen.size, 200);
    assert.equal(ivs.size, 200);
    assert.equal(Buffer.from([...ivs][0], 'base64').length, 12);
  });

  test('ciphertext does not contain the plaintext', () => {
    assert.ok(!encrypt('fpt_visible_token_123', KEY).includes('fpt_visible_token_123'));
  });

  test('tampering is detected (GCM auth tag)', () => {
    const [v, iv, tag, ct] = encrypt('token-value-1', KEY).split('.');
    const flipped = Buffer.from(ct, 'base64');
    flipped[0] ^= 1;
    assert.throws(() => decrypt([v, iv, tag, flipped.toString('base64')].join('.'), KEY));
  });

  test('wrong key or wrong AAD (ciphertext moved to another platform) fails', () => {
    const c = encrypt('token-value-2', KEY, 'instagram');
    assert.throws(() => decrypt(c, crypto.randomBytes(32), 'instagram'));
    assert.throws(() => decrypt(c, KEY, 'x'));
  });

  test('key must be exactly 32 bytes', () => {
    assert.throws(() => parseKey('c2hvcnQ='));
    assert.equal(parseKey(crypto.randomBytes(32).toString('base64')).length, 32);
  });
});

describe('webhook signatures', () => {
  const secret = 'whsec_test';
  const body = JSON.stringify({ id: 'evt_1', type: 'post.published' });

  test('valid signature verifies', () => {
    assert.deepEqual(verify(body, sign(body, secret), secret), { ok: true });
  });
  test('modified body is rejected', () => {
    assert.equal(verify(body.replace('published', 'failed'), sign(body, secret), secret).reason, 'signature_mismatch');
  });
  test('wrong secret (forged) is rejected', () => {
    assert.equal(verify(body, sign(body, 'attacker'), secret).ok, false);
  });
  test('missing / malformed header is rejected', () => {
    assert.equal(verify(body, undefined, secret).reason, 'missing_signature');
    assert.equal(verify(body, 'garbage', secret).ok, false);
    assert.equal(verify(body, 't=abc,v1=', secret).ok, false);
  });
  test('replay of an old (validly signed) webhook is rejected by the timestamp window', () => {
    const old = Math.floor(Date.now() / 1000) - 3600;
    assert.equal(verify(body, sign(body, secret, old), secret, { toleranceSec: 300 }).reason, 'timestamp_out_of_tolerance');
  });
  test('the timestamp is covered by the MAC: it cannot be swapped to dodge the window', () => {
    const old = Math.floor(Date.now() / 1000) - 3600;
    const sig = sign(body, secret, old);
    const fresh = sig.replace(`t=${old}`, `t=${Math.floor(Date.now() / 1000)}`);
    assert.equal(verify(body, fresh, secret).reason, 'signature_mismatch');
  });
});

describe('Retry-After and backoff', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  test('parses delay-seconds', () => assert.equal(parseRetryAfter('30'), 30_000));
  test('parses an HTTP-date', () => assert.equal(parseRetryAfter('Thu, 01 Jan 2026 00:00:45 GMT', now), 45_000));
  test('past dates and garbage are safe', () => {
    assert.equal(parseRetryAfter('Wed, 31 Dec 2025 23:00:00 GMT', now), 0);
    assert.equal(parseRetryAfter('soon', now), 5_000);
    assert.equal(parseRetryAfter(null), 5_000);
  });
  test('absurd values are capped at an hour', () => assert.equal(parseRetryAfter('99999999'), 3_600_000));

  test('backoff grows exponentially, stays inside [ceiling/2, ceiling], and is capped', () => {
    const cfg = { baseMs: 1000, maxMs: 8000 };
    const bounds = (attempt) => [backoffMs(attempt, cfg, () => 0), backoffMs(attempt, cfg, () => 0.999999)];
    assert.deepEqual(bounds(1), [500, 1000]);
    assert.deepEqual(bounds(2), [1000, 2000]);
    assert.deepEqual(bounds(3), [2000, 4000]);
    assert.deepEqual(bounds(10), [4000, 8000]);
  });
});

describe('log redaction', () => {
  test('sensitive keys and registered secret values never reach the sink', () => {
    const lines = [];
    setLogSink((l) => lines.push(l));
    addSecret('fpt_supersecret_value_123');
    log.info('got token fpt_supersecret_value_123', {
      accessToken: 'abc',
      nested: { authorization: 'Bearer zzz', note: 'value fpt_supersecret_value_123 inline' },
      client_secret: 'shh',
      ok: 'fine',
    });
    setLogSink((l) => process.stdout.write(l + '\n'));
    const out = lines.join('\n');
    assert.ok(!out.includes('fpt_supersecret_value_123'));
    assert.ok(!out.includes('Bearer zzz'));
    assert.ok(!out.includes('shh'));
    assert.ok(out.includes('fine'));
  });
});

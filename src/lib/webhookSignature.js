import crypto from 'node:crypto';
import { timingSafeEqualStr } from './crypto.js';

// Signature scheme (Stripe-like): header `X-Signature: t=<unix seconds>,v1=<hex>`
// where v1 = HMAC-SHA256(secret, `${t}.${rawBody}`). Signing the timestamp too gives
// replay protection: a captured webhook stops verifying once t leaves the tolerance.
export function sign(rawBody, secret, timestampSec = Math.floor(Date.now() / 1000)) {
  const v1 = crypto.createHmac('sha256', secret).update(`${timestampSec}.${rawBody}`).digest('hex');
  return `t=${timestampSec},v1=${v1}`;
}

export function verify(rawBody, header, secret, { toleranceSec = 300, nowSec = Math.floor(Date.now() / 1000) } = {}) {
  if (typeof header !== 'string') return { ok: false, reason: 'missing_signature' };
  const parts = Object.fromEntries(
    header.split(',').map((kv) => {
      const i = kv.indexOf('=');
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
    }),
  );
  const t = Number.parseInt(parts.t, 10);
  if (!Number.isFinite(t) || !parts.v1) return { ok: false, reason: 'malformed_signature' };
  if (Math.abs(nowSec - t) > toleranceSec) return { ok: false, reason: 'timestamp_out_of_tolerance' };
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  if (!timingSafeEqualStr(expected, parts.v1)) return { ok: false, reason: 'signature_mismatch' };
  return { ok: true };
}

import crypto from 'node:crypto';

// AES-256-GCM with a fresh random 96-bit IV per encryption. The IV is stored next to
// the ciphertext (it is not secret, it only has to be unique). The GCM tag makes
// tampering detectable, and the AAD binds a ciphertext to its purpose (e.g. platform),
// so a token copied to another row fails to decrypt.
const VERSION = 'v1';

export function parseKey(b64) {
  const key = Buffer.from(b64 ?? '', 'base64');
  if (key.length !== 32) {
    throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded');
  }
  return key;
}

export function encrypt(plaintext, key, aad = '') {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join('.');
}

export function decrypt(payload, key, aad = '') {
  const [v, iv, tag, ct] = String(payload).split('.');
  if (v !== VERSION || !iv || !tag || !ct) throw new Error('Unsupported ciphertext format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
}

export function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    // still burn a comparison so timing does not reveal a length match
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

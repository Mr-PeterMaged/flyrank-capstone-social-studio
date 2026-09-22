import { encrypt, decrypt } from '../lib/crypto.js';
import { addSecret } from '../lib/logger.js';

const EXPIRY_MARGIN_MS = 60_000; // refresh a minute early, never publish with a dying token

/**
 * OAuth token custody. Access tokens are stored ONLY as AES-256-GCM ciphertext (random
 * IV per write, AAD = platform). Plaintext exists in memory just long enough to build an
 * Authorization header, and is registered with the logger so it is scrubbed if it ever
 * leaks into a message.
 */
export class TokenStore {
  constructor({ repos, key, oauth, now = Date.now }) {
    this.repos = repos;
    this.key = key;
    this.oauth = oauth;
    this.now = now;
    this.inFlight = new Map(); // platform -> Promise, so concurrent jobs share ONE refresh
  }

  async getAccessToken(platform) {
    const row = this.repos.tokens.get(platform);
    if (row && row.expires_at - EXPIRY_MARGIN_MS > this.now()) {
      try {
        const token = decrypt(row.access_token_enc, this.key, platform);
        addSecret(token);
        return token;
      } catch {
        // Wrong key / tampered ciphertext: treat as missing and re-authenticate.
        this.repos.tokens.delete(platform);
      }
    }
    return this.refresh(platform);
  }

  invalidate(platform) {
    this.repos.tokens.delete(platform);
  }

  refresh(platform) {
    let p = this.inFlight.get(platform);
    if (!p) {
      p = (async () => {
        const { accessToken, expiresInSec } = await this.oauth.requestToken(platform);
        addSecret(accessToken);
        this.repos.tokens.put(platform, encrypt(accessToken, this.key, platform), this.now() + expiresInSec * 1000);
        return accessToken;
      })().finally(() => this.inFlight.delete(platform));
      this.inFlight.set(platform, p);
    }
    return p;
  }
}

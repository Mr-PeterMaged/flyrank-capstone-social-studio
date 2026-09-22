import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup, waitFor } from './helpers.js';
import { decrypt, parseKey } from '../src/lib/crypto.js';

// PROBE 6: "Grep the database and logs -> no plaintext token anywhere; stored tokens are encrypted."
describe('secrets never appear in plaintext (probe 6)', () => {
  let t;
  before(async () => {
    t = await setup({ silenceLogs: true });
  });
  after(() => t.teardown());

  test('OAuth tokens are ciphertext at rest; DB files and logs contain no secret', async () => {
    const c = await t.approvedCampaign();
    // Provoke retry / rate-limit logging paths too, not just the happy path.
    await t.admin('/rate-limit', { retryAfter: 1, platform: 'x' });
    await t.admin('/faults', { faults: ['error_500'] });
    await t.api('POST', `/api/campaigns/${c.id}/publish`, {});
    await waitFor(async () => {
      await t.tickAll();
      return Object.values(await t.statuses(c.id)).every((s) => s === 'published');
    }, { timeout: 8000 });

    // 1. the token rows exist and are encrypted with the random-IV format
    const rows = t.container.db.prepare('SELECT platform, access_token_enc FROM oauth_tokens ORDER BY platform').all();
    assert.equal(rows.length, 3);
    const plaintextTokens = [...t.platform.state.tokens.keys()];
    assert.ok(plaintextTokens.length >= 3 && plaintextTokens.every((tok) => tok.startsWith('fpt_')));
    for (const r of rows) {
      assert.match(r.access_token_enc, /^v1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/);
      assert.ok(!plaintextTokens.some((tok) => r.access_token_enc.includes(tok)));
      // and it really is a valid token when decrypted with the key + platform binding
      const back = decrypt(r.access_token_enc, parseKey(t.secrets.encKey), r.platform);
      assert.ok(plaintextTokens.includes(back));
    }
    assert.equal(new Set(rows.map((r) => r.access_token_enc.split('.')[1])).size, 3, 'each row has its own IV');

    // 2. raw bytes of the database (+ WAL) contain none of the secrets
    const secrets = [...plaintextTokens, t.secrets.clientSecret, t.secrets.webhookSecret, t.secrets.apiKey, t.secrets.encKey];
    const scanDb = () => {
      for (const f of fs.readdirSync(t.dir).filter((n) => n.startsWith('studio.db'))) {
        const bytes = fs.readFileSync(path.join(t.dir, f));
        for (const s of secrets) assert.ok(!bytes.includes(s), `${f} leaks a secret`);
      }
    };
    scanDb();
    t.container.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    scanDb();

    // 3. the logs contain none of them either (and there ARE logs, so this is not vacuous)
    const logText = t.logs.join('\n');
    assert.ok(t.logs.length > 3, 'logs were captured');
    assert.match(logText, /rate limited|publish will retry|delivery confirmed/);
    for (const s of secrets) assert.ok(!logText.includes(s), 'a secret appeared in the logs');

    // 4. API responses never expose tokens either
    const body = JSON.stringify((await t.api('GET', `/api/campaigns/${c.id}`)).body) + JSON.stringify((await t.api('GET', '/api/history')).body);
    for (const s of secrets) assert.ok(!body.includes(s));
  });

  test('a corrupted / foreign-key ciphertext is discarded and the token is re-issued, not trusted', async () => {
    t.container.db.prepare("UPDATE oauth_tokens SET access_token_enc = 'v1.AAAA.BBBB.CCCC' WHERE platform = 'x'").run();
    const fresh = await t.container.tokenStore.getAccessToken('x');
    assert.match(fresh, /^fpt_/);
  });
});

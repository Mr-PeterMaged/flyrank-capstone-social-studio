import path from 'node:path';
import fs from 'node:fs';

// Node >= 22 can load .env natively; real environment variables always win.
export function loadDotEnv(file = '.env') {
  try {
    if (fs.existsSync(file)) process.loadEnvFile(file);
  } catch {
    /* a malformed .env should not crash tooling; missing vars are caught in assertConfig */
  }
}

const int = (v, d) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));
const bool = (v, d) => (v === undefined || v === '' ? d : ['1', 'true', 'yes'].includes(String(v).toLowerCase()));

export function loadConfig(overrides = {}) {
  const e = { ...process.env, ...overrides };
  const dataDir = path.resolve(e.DATA_DIR ?? './data');
  return {
    port: int(e.PORT, 3100),
    publicBaseUrl: e.PUBLIC_BASE_URL ?? `http://localhost:${int(e.PORT, 3100)}`,
    apiKey: e.API_KEY,
    tokenEncryptionKey: e.TOKEN_ENCRYPTION_KEY,
    dataDir,
    dbPath: e.DB_PATH ?? path.join(dataDir, 'studio.db'),
    artifactDir: path.join(dataDir, 'artifacts'),
    brandName: e.BRAND_NAME ?? 'Social Media Studio',
    worker: {
      inProcess: bool(e.WORKER_IN_PROCESS, true),
      pollMs: int(e.WORKER_POLL_MS, 1000),
      leaseMs: int(e.WORKER_LEASE_MS, 30_000),
      batchSize: int(e.WORKER_BATCH_SIZE, 10),
      maxAttempts: int(e.MAX_ATTEMPTS, 8),
      backoffBaseMs: int(e.BACKOFF_BASE_MS, 2000),
      backoffMaxMs: int(e.BACKOFF_MAX_MS, 5 * 60_000),
    },
    demoControls: bool(e.ENABLE_DEMO_CONTROLS, false),
    platform: {
      baseUrl: e.PLATFORM_BASE_URL ?? 'http://localhost:4010',
      timeoutMs: int(e.PLATFORM_TIMEOUT_MS, 3000),
      clientId: e.PLATFORM_CLIENT_ID,
      clientSecret: e.PLATFORM_CLIENT_SECRET,
    },
    webhook: {
      secret: e.WEBHOOK_SECRET,
      toleranceSec: int(e.WEBHOOK_TOLERANCE_SEC, 300),
    },
    // Test-only fault hook: the worker process exits abruptly right after the
    // platform accepted a post, before the result is persisted (a real crash).
    faults: { crashAfterAccept: bool(e.FAULT_CRASH_AFTER_ACCEPT, false) },
  };
}

// Fail fast, with a clear message, instead of failing on the first request.
export function assertConfig(cfg) {
  const missing = [];
  if (!cfg.apiKey) missing.push('API_KEY');
  if (!cfg.tokenEncryptionKey) missing.push('TOKEN_ENCRYPTION_KEY');
  if (!cfg.platform.clientId) missing.push('PLATFORM_CLIENT_ID');
  if (!cfg.platform.clientSecret) missing.push('PLATFORM_CLIENT_SECRET');
  if (!cfg.webhook.secret) missing.push('WEBHOOK_SECRET');
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')} (copy .env.example to .env)`);
  }
  // Refuse to run with the placeholder secrets shipped in .env.example.
  const placeholders = Object.entries({
    API_KEY: cfg.apiKey,
    PLATFORM_CLIENT_SECRET: cfg.platform.clientSecret,
    WEBHOOK_SECRET: cfg.webhook.secret,
    TOKEN_ENCRYPTION_KEY: cfg.tokenEncryptionKey,
  }).filter(([, v]) => /^change-me|REPLACE_WITH/i.test(v));
  if (placeholders.length) {
    throw new Error(`Replace the placeholder value(s) in .env: ${placeholders.map(([k]) => k).join(', ')} (see the generation commands in .env.example)`);
  }
  return cfg;
}

import fs from 'node:fs';
import { openDb } from './db/index.js';
import { createRepos } from './db/repos.js';
import { Clock } from './lib/clock.js';
import { parseKey } from './lib/crypto.js';
import { addSecret } from './lib/logger.js';
import { createOAuthClient } from './adapters/platformOAuth.js';
import { createPublisherRegistry } from './adapters/index.js';
import { TokenStore } from './services/tokenStore.js';
import { createCampaignService } from './services/campaignService.js';
import { createSchedulingService } from './services/schedulingService.js';
import { createWebhookService } from './services/webhookService.js';
import { PublishWorker } from './services/publishWorker.js';

/**
 * Composition root: the only place where concrete pieces are wired together.
 * Both the web process and the standalone worker process build the SAME container from
 * the same database, which is what makes the queue durable and shareable.
 */
export function createContainer(config, { fetchImpl = fetch, workerId } = {}) {
  fs.mkdirSync(config.artifactDir, { recursive: true });
  const db = openDb(config.dbPath);
  const repos = createRepos(db);
  const clock = new Clock(repos.settings);

  addSecret(config.platform.clientSecret);
  addSecret(config.webhook.secret);
  addSecret(config.apiKey);

  const oauth = createOAuthClient({
    baseUrl: config.platform.baseUrl,
    clientId: config.platform.clientId,
    clientSecret: config.platform.clientSecret,
    fetchImpl,
  });
  const tokenStore = new TokenStore({ repos, key: parseKey(config.tokenEncryptionKey), oauth });
  const publishers = createPublisherRegistry({
    baseUrl: config.platform.baseUrl,
    tokenStore,
    timeoutMs: config.platform.timeoutMs,
    fetchImpl,
  });

  return {
    config,
    db,
    repos,
    clock,
    tokenStore,
    publishers,
    campaigns: createCampaignService({ repos, config }),
    scheduling: createSchedulingService({ repos, clock }),
    webhooks: createWebhookService({ repos, config }),
    worker: new PublishWorker({ repos, clock, publishers, config, workerId }),
    close: () => db.close(),
  };
}

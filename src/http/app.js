import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { AppError, unauthorized } from '../lib/errors.js';
import { timingSafeEqualStr } from '../lib/crypto.js';
import { log } from '../lib/logger.js';
import { apiRouter } from './routes/api.js';
import { webhookRouter } from './routes/webhook.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');

function requireApiKey(config) {
  return (req, _res, next) => {
    const m = /^Bearer (.+)$/.exec(req.get('authorization') ?? '');
    if (!m || !timingSafeEqualStr(m[1], config.apiKey)) return next(unauthorized());
    next();
  };
}

export function createApp(container) {
  const { config } = container;
  const app = express();
  app.disable('x-powered-by');

  app.get('/health', (_req, res) => res.json({ ok: true, service: 'social-media-studio' }));

  // The webhook is authenticated by its SIGNATURE, not the API key, and it needs the raw
  // bytes (the HMAC covers them exactly), so it is mounted before any JSON parser.
  app.use('/webhook', webhookRouter(container));

  app.use('/artifacts', express.static(config.artifactDir, { fallthrough: false, index: false }));
  app.use(express.static(PUBLIC_DIR));

  app.use('/api', requireApiKey(config), express.json({ limit: '100kb' }), apiRouter(container));
  app.use('/api', (_req, _res, next) => next(new AppError(404, 'not_found', 'No such API route')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err instanceof AppError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err instanceof ZodError) {
      return res.status(400).json({
        error: {
          code: 'validation_error',
          message: 'Request validation failed',
          details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      });
    }
    if (err?.type === 'entity.parse.failed' || err?.type === 'entity.too.large') {
      return res.status(err.status).json({ error: { code: 'bad_body', message: 'Malformed or oversized request body' } });
    }
    if (err?.status === 404 && req.path.startsWith('/artifacts')) return res.status(404).json({ error: { code: 'not_found', message: 'No such artifact' } });
    log.error('unhandled error', { error: err, path: req.path });
    res.status(500).json({ error: { code: 'internal_error', message: 'Internal server error' } });
  });

  return app;
}

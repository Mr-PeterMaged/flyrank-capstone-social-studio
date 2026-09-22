import express from 'express';
import { wrap } from '../wrap.js';

export function webhookRouter({ webhooks }) {
  const router = express.Router();
  // Raw body: the signature is computed over the exact bytes the platform sent.
  router.post(
    '/social-delivery',
    express.raw({ type: () => true, limit: '64kb' }),
    wrap((req, res) => {
      const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
      const { status, body } = webhooks.handleDelivery(rawBody, req.get('x-signature'));
      res.status(status).json(body);
    }),
  );
  return router;
}

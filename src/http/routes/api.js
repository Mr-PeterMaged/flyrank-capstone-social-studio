import express from 'express';
import { wrap } from '../wrap.js';
import { AppError } from '../../lib/errors.js';
import * as S from '../schemas.js';

// HTTP layer: parse + validate input, call one service method, shape the response.
// No SQL and no business rules here.
export function apiRouter({ campaigns, scheduling, repos, clock, worker, config }) {
  const r = express.Router();

  // ------------------------------------------------------------ posts
  r.post('/posts', wrap((req, res) => res.status(201).json(campaigns.createPost(S.createPostBody.parse(req.body)))));
  r.get('/posts', wrap((_req, res) => res.json(campaigns.listPosts())));
  r.get('/posts/:id', wrap((req, res) => res.json(campaigns.getPost(S.id.parse(req.params.id)))));

  // ------------------------------------------------------------ campaigns
  r.post(
    '/posts/:id/campaigns',
    wrap(async (req, res) => {
      const body = S.createCampaignBody.parse(req.body ?? {});
      const created = await campaigns.createCampaign(S.id.parse(req.params.id), {
        platforms: body.platforms,
        captionOverrides: body.captions,
      });
      res.status(201).json(created);
    }),
  );
  r.get('/campaigns', wrap((_req, res) => res.json(campaigns.listCampaigns())));
  r.get('/campaigns/:id', wrap((req, res) => res.json(campaigns.getCampaign(S.id.parse(req.params.id)))));

  // ------------------------------------------------------------ review workflow
  r.patch('/variants/:id', wrap((req, res) => res.json(campaigns.editVariant(S.id.parse(req.params.id), S.editVariantBody.parse(req.body).caption))));
  r.post('/variants/:id/approve', wrap((req, res) => res.json(campaigns.approveVariant(S.id.parse(req.params.id)))));
  r.post('/variants/:id/reject', wrap((req, res) => res.json(campaigns.rejectVariant(S.id.parse(req.params.id)))));

  // ------------------------------------------------------------ scheduling / publishing
  const respondEntries = (res, results) => {
    const anyCreated = results.some((x) => !x.replayed);
    res.status(anyCreated ? 201 : 200).json({
      schedulerNow: new Date(clock.now()).toISOString(),
      entries: results.map((x) => ({ ...x.entry, replayed: x.replayed, ...(x.rescheduled ? { rescheduled: true } : {}) })),
    });
  };

  r.post(
    '/campaigns/:id/schedule',
    wrap((req, res) => {
      const body = S.scheduleBody.parse(req.body ?? {});
      const atMs = body.at !== undefined ? Date.parse(body.at) : clock.now() + body.inSeconds * 1000;
      respondEntries(res, scheduling.schedule(S.id.parse(req.params.id), { atMs, platforms: body.platforms }));
    }),
  );
  r.post(
    '/campaigns/:id/publish',
    wrap((req, res) => {
      const body = S.publishBody.parse(req.body ?? {});
      respondEntries(res, scheduling.publishNow(S.id.parse(req.params.id), { platforms: body.platforms }));
    }),
  );

  // ------------------------------------------------------------ history
  r.get('/campaigns/:id/history', wrap((req, res) => {
    const id = S.id.parse(req.params.id);
    campaigns.getCampaign(id); // 404 if unknown
    res.json(repos.attempts.listByCampaign(id));
  }));
  r.get('/history', wrap((req, res) => res.json(repos.attempts.listRecent(Math.min(Number(req.query.limit) || 100, 500)))));

  // ------------------------------------------------------------ demo controls
  if (config.demoControls) {
    const demo = express.Router();
    const clockView = () => ({ schedulerNow: new Date(clock.now()).toISOString(), offsetMs: clock.offsetMs() });
    demo.get('/clock', (_req, res) => res.json(clockView()));
    demo.post('/clock/advance', wrap((req, res) => {
      clock.advance(S.advanceClockBody.parse(req.body).seconds * 1000);
      res.json(clockView());
    }));
    demo.post('/clock/reset', (_req, res) => {
      clock.reset();
      res.json(clockView());
    });
    demo.post('/worker/tick', wrap(async (_req, res) => {
      let handled = 0;
      let n;
      while ((n = await worker.tick()) > 0) handled += n;
      res.json({ handled });
    }));
    demo.get('/limits', (_req, res) => res.json(repos.limits.list()));
    r.use('/admin', demo);
  } else {
    r.use('/admin', () => {
      throw new AppError(404, 'not_found', 'Demo controls are disabled');
    });
  }

  return r;
}

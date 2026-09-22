// Repositories: the ONLY place that knows SQL. Services depend on these, never on the
// database driver, so swapping SQLite for Postgres touches this file alone.
import { tx } from './index.js';

const one = (row) => (row ? { ...row } : null);
const many = (rows) => rows.map((r) => ({ ...r }));

const toPost = (r) => (r ? { id: r.id, title: r.title, body: r.body, url: r.url, createdAt: r.created_at } : null);

const toVariant = (r) =>
  !r ? null : {
    id: r.id,
    campaignId: r.campaign_id,
    platform: r.platform,
    caption: r.caption,
    imagePath: r.image_path,
    imageWidth: r.image_width,
    imageHeight: r.image_height,
    reviewStatus: r.review_status,
    validationErrors: JSON.parse(r.validation_errors),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };

// SocialPostEntry-shaped record.
const toSocialPost = (r) =>
  !r ? null : {
    id: r.id,
    variantId: r.variant_id,
    campaignId: r.campaign_id,
    platform: r.platform,
    status: r.status,
    idempotencyKey: r.idempotency_key,
    scheduledAt: r.scheduled_at,
    nextAttemptAt: r.next_attempt_at,
    attempts: r.attempts,
    lockedBy: r.locked_by,
    lockExpiresAt: r.lock_expires_at,
    platformPostId: r.platform_post_id,
    postUrl: r.post_url,
    lastError: r.last_error,
    publishedAt: r.published_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };

export function createRepos(db) {
  const q = (sql) => db.prepare(sql);

  const posts = {
    create({ title, body, url }) {
      const r = q('INSERT INTO posts (title, body, url, created_at) VALUES (?,?,?,?) RETURNING *').get(title, body, url, Date.now());
      return toPost(r);
    },
    get: (id) => toPost(q('SELECT * FROM posts WHERE id = ?').get(id)),
    list: () => q('SELECT * FROM posts ORDER BY id DESC').all().map(toPost),
  };

  const campaigns = {
    create(postId) {
      return one(q('INSERT INTO campaigns (post_id, created_at) VALUES (?,?) RETURNING *').get(postId, Date.now()));
    },
    get: (id) => one(q('SELECT * FROM campaigns WHERE id = ?').get(id)),
    list: () => many(q('SELECT * FROM campaigns ORDER BY id DESC').all()),
  };

  const variants = {
    create(v) {
      const now = Date.now();
      return toVariant(
        q(`INSERT INTO variants (campaign_id, platform, caption, image_path, image_width, image_height,
                                 review_status, validation_errors, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING *`).get(
          v.campaignId, v.platform, v.caption, v.imagePath, v.imageWidth, v.imageHeight,
          v.reviewStatus, JSON.stringify(v.validationErrors ?? []), now, now,
        ),
      );
    },
    get: (id) => toVariant(q('SELECT * FROM variants WHERE id = ?').get(id)),
    listByCampaign: (cid) => q('SELECT * FROM variants WHERE campaign_id = ? ORDER BY id').all(cid).map(toVariant),
    // Conditional update = optimistic concurrency: the transition only happens from the
    // expected state, so two reviewers (or a retried request) cannot both win.
    transition(id, fromStatuses, toStatus) {
      const marks = fromStatuses.map(() => '?').join(',');
      const r = q(
        `UPDATE variants SET review_status = ?, updated_at = ? WHERE id = ? AND review_status IN (${marks}) RETURNING *`,
      ).get(toStatus, Date.now(), id, ...fromStatuses);
      return toVariant(r);
    },
    updateCaption(id, caption, reviewStatus, validationErrors) {
      return toVariant(
        q(`UPDATE variants SET caption = ?, review_status = ?, validation_errors = ?, updated_at = ?
           WHERE id = ? AND review_status IN ('draft','blocked') RETURNING *`).get(
          caption, reviewStatus, JSON.stringify(validationErrors), Date.now(), id,
        ),
      );
    },
  };

  const socialPosts = {
    get: (id) => toSocialPost(q('SELECT * FROM social_posts WHERE id = ?').get(id)),
    getByVariant: (vid) => toSocialPost(q('SELECT * FROM social_posts WHERE variant_id = ?').get(vid)),
    getByIdempotencyKey: (k) => toSocialPost(q('SELECT * FROM social_posts WHERE idempotency_key = ?').get(k)),
    listByCampaign: (cid) => q('SELECT * FROM social_posts WHERE campaign_id = ? ORDER BY id').all(cid).map(toSocialPost),

    /** Insert-if-absent. `created` tells the caller whether this call made the row. */
    createIfAbsent({ variantId, campaignId, platform, idempotencyKey, scheduledAt }) {
      const now = Date.now();
      const r = q(
        `INSERT INTO social_posts (variant_id, campaign_id, platform, status, idempotency_key,
                                   scheduled_at, next_attempt_at, created_at, updated_at)
         VALUES (?,?,?,'queued',?,?,?,?,?) ON CONFLICT(variant_id) DO NOTHING RETURNING *`,
      ).get(variantId, campaignId, platform, idempotencyKey, scheduledAt, scheduledAt, now, now);
      if (r) return { entry: toSocialPost(r), created: true };
      return { entry: toSocialPost(q('SELECT * FROM social_posts WHERE variant_id = ?').get(variantId)), created: false };
    },

    /** Only a not-yet-attempted queued post may move. Once an attempt started the
     *  idempotency key is "in the wild" and the slot is frozen. */
    reschedule(id, scheduledAt) {
      return toSocialPost(
        q(`UPDATE social_posts SET scheduled_at = ?, next_attempt_at = ?, updated_at = ?
           WHERE id = ? AND status = 'queued' AND attempts = 0 RETURNING *`).get(scheduledAt, scheduledAt, Date.now(), id),
      );
    },

    /**
     * Atomically claim due work. A single UPDATE ... RETURNING is atomic in SQLite, so
     * two workers can never claim the same row. Also reclaims rows whose worker died
     * (status=publishing, lease expired, platform never confirmed acceptance).
     */
    claimDue({ workerId, now, realNow, leaseMs, limit }) {
      return q(
        `UPDATE social_posts
            SET status = 'publishing', locked_by = @workerId, lock_expires_at = @leaseUntil,
                attempts = attempts + 1, updated_at = @realNow
          WHERE id IN (
            SELECT sp.id FROM social_posts sp
             WHERE ( (sp.status = 'queued' AND sp.next_attempt_at <= @now)
                  OR (sp.status = 'publishing' AND sp.platform_post_id IS NULL
                      AND sp.lock_expires_at IS NOT NULL AND sp.lock_expires_at < @realNow) )
               AND NOT EXISTS (SELECT 1 FROM platform_limits pl
                                WHERE pl.platform = sp.platform AND pl.blocked_until > @now)
             ORDER BY sp.next_attempt_at, sp.id
             LIMIT @limit)
          RETURNING *`,
      )
        .all({ workerId, leaseUntil: realNow + leaseMs, realNow, now, limit })
        .map(toSocialPost);
    },

    // All worker-side writes are fenced by locked_by: a zombie whose lease expired (and
    // whose job another worker took over) cannot overwrite the new owner's state.
    markAccepted(id, workerId, { platformPostId, postUrl }) {
      return toSocialPost(
        q(`UPDATE social_posts SET platform_post_id = ?, post_url = ?, last_error = NULL,
                  locked_by = NULL, lock_expires_at = NULL, updated_at = ?
            WHERE id = ? AND status = 'publishing' AND locked_by = ? RETURNING *`).get(
          platformPostId, postUrl ?? null, Date.now(), id, workerId,
        ),
      );
    },
    // refundAttempt: a 429 is the platform saying "not now", not a failure of ours, so it
    // must not eat into the retry budget.
    scheduleRetry(id, workerId, { nextAttemptAt, error, refundAttempt = false }) {
      return toSocialPost(
        q(`UPDATE social_posts SET status = 'queued', next_attempt_at = ?, last_error = ?,
                  attempts = attempts - ?, locked_by = NULL, lock_expires_at = NULL, updated_at = ?
            WHERE id = ? AND status = 'publishing' AND locked_by = ? RETURNING *`).get(
          nextAttemptAt, error, refundAttempt ? 1 : 0, Date.now(), id, workerId,
        ),
      );
    },
    markFailed(id, error) {
      return toSocialPost(
        q(`UPDATE social_posts SET status = 'failed', last_error = ?, locked_by = NULL,
                  lock_expires_at = NULL, updated_at = ?
            WHERE id = ? AND status IN ('queued','publishing') RETURNING *`).get(error, Date.now(), id),
      );
    },
    /** Verified-webhook transition. Terminal states are never overwritten. */
    applyDelivery(id, outcome, { postUrl, reason }) {
      const now = Date.now();
      return toSocialPost(
        q(`UPDATE social_posts
              SET status = ?, post_url = COALESCE(?, post_url), last_error = ?,
                  published_at = CASE WHEN ? = 'published' THEN ? ELSE published_at END,
                  locked_by = NULL, lock_expires_at = NULL, updated_at = ?
            WHERE id = ? AND status IN ('queued','publishing') RETURNING *`).get(
          outcome, postUrl ?? null, outcome === 'failed' ? (reason ?? 'delivery_failed') : null,
          outcome, now, now, id,
        ),
      );
    },
    countByStatus: () => many(q('SELECT status, COUNT(*) AS n FROM social_posts GROUP BY status').all()),
  };

  const attempts = {
    record({ socialPostId, attemptNo, outcome, httpStatus, detail, workerId }) {
      q(`INSERT INTO publish_attempts (social_post_id, attempt_no, outcome, http_status, detail, worker_id, created_at)
         VALUES (?,?,?,?,?,?,?)`).run(socialPostId, attemptNo, outcome, httpStatus ?? null, detail ?? null, workerId ?? null, Date.now());
    },
    listByCampaign: (cid) =>
      many(
        q(`SELECT a.*, sp.platform, sp.variant_id FROM publish_attempts a
             JOIN social_posts sp ON sp.id = a.social_post_id
            WHERE sp.campaign_id = ? ORDER BY a.id`).all(cid),
      ),
    listRecent: (limit = 100) =>
      many(
        q(`SELECT a.*, sp.platform, sp.variant_id, sp.campaign_id FROM publish_attempts a
             JOIN social_posts sp ON sp.id = a.social_post_id ORDER BY a.id DESC LIMIT ?`).all(limit),
      ),
  };

  const tokens = {
    get: (platform) => one(q('SELECT * FROM oauth_tokens WHERE platform = ?').get(platform)),
    put(platform, accessTokenEnc, expiresAt) {
      q(`INSERT INTO oauth_tokens (platform, access_token_enc, expires_at, updated_at) VALUES (?,?,?,?)
         ON CONFLICT(platform) DO UPDATE SET access_token_enc = excluded.access_token_enc,
                                             expires_at = excluded.expires_at, updated_at = excluded.updated_at`).run(
        platform, accessTokenEnc, expiresAt, Date.now(),
      );
    },
    delete: (platform) => q('DELETE FROM oauth_tokens WHERE platform = ?').run(platform),
  };

  const limits = {
    /** Never shortens an existing block. */
    block(platform, until) {
      q(`INSERT INTO platform_limits (platform, blocked_until) VALUES (?,?)
         ON CONFLICT(platform) DO UPDATE SET blocked_until = MAX(blocked_until, excluded.blocked_until)`).run(platform, until);
    },
    list: () => many(q('SELECT * FROM platform_limits').all()),
  };

  const webhookEvents = {
    /** true if this event id is new (first delivery), false if already processed. */
    tryRecord({ eventId, socialPostId, type, outcome }) {
      const r = q(
        `INSERT INTO webhook_events (event_id, social_post_id, type, outcome, received_at)
         VALUES (?,?,?,?,?) ON CONFLICT(event_id) DO NOTHING RETURNING event_id`,
      ).get(eventId, socialPostId ?? null, type, outcome, Date.now());
      return Boolean(r);
    },
  };

  const settings = {
    get: (key) => q('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null,
    set: (key, value) =>
      q('INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value),
  };

  return { db, tx: (fn) => tx(db, fn), posts, campaigns, variants, socialPosts, attempts, tokens, limits, webhookEvents, settings };
}

-- Time columns named *_at that drive scheduling (scheduled_at, next_attempt_at,
-- blocked_until) are in "scheduler clock" milliseconds (real time + demo offset).
-- lock_expires_at and every created_at/updated_at are REAL time milliseconds.

CREATE TABLE posts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  title         TEXT    NOT NULL,
  body          TEXT    NOT NULL,
  url           TEXT    NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE campaigns (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id       INTEGER NOT NULL REFERENCES posts(id),
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_campaigns_post ON campaigns(post_id);

-- One platform-specific version of the post. review_status is the human workflow;
-- delivery status lives in social_posts and is driven by the worker + verified webhooks.
CREATE TABLE variants (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id       INTEGER NOT NULL REFERENCES campaigns(id),
  platform          TEXT    NOT NULL,
  caption           TEXT    NOT NULL,
  image_path        TEXT    NOT NULL,
  image_width       INTEGER NOT NULL,
  image_height      INTEGER NOT NULL,
  review_status     TEXT    NOT NULL CHECK (review_status IN ('draft','approved','rejected','blocked')),
  validation_errors TEXT    NOT NULL DEFAULT '[]',
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  UNIQUE (campaign_id, platform)
);

-- SocialPostEntry-shaped record AND the durable job: one row per variant, ever.
-- UNIQUE(variant_id) + UNIQUE(idempotency_key) make a duplicate schedule impossible
-- at the database level, not just in application code.
CREATE TABLE social_posts (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  variant_id       INTEGER NOT NULL UNIQUE REFERENCES variants(id),
  campaign_id      INTEGER NOT NULL REFERENCES campaigns(id),
  platform         TEXT    NOT NULL,
  status           TEXT    NOT NULL CHECK (status IN ('queued','publishing','published','failed')),
  idempotency_key  TEXT    NOT NULL UNIQUE,
  scheduled_at     INTEGER NOT NULL,
  next_attempt_at  INTEGER NOT NULL,
  attempts         INTEGER NOT NULL DEFAULT 0,
  locked_by        TEXT,
  lock_expires_at  INTEGER,
  platform_post_id TEXT,
  post_url         TEXT,
  last_error       TEXT,
  published_at     INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX idx_social_posts_due ON social_posts(status, next_attempt_at);
CREATE INDEX idx_social_posts_campaign ON social_posts(campaign_id);
CREATE INDEX idx_social_posts_platform_post ON social_posts(platform_post_id);

-- Every publish attempt and its result (the visible "publish history").
CREATE TABLE publish_attempts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  social_post_id INTEGER NOT NULL REFERENCES social_posts(id),
  attempt_no     INTEGER NOT NULL,
  outcome        TEXT    NOT NULL,
  http_status    INTEGER,
  detail         TEXT,
  worker_id      TEXT,
  created_at     INTEGER NOT NULL
);
CREATE INDEX idx_attempts_post ON publish_attempts(social_post_id);

-- OAuth access tokens, ENCRYPTED (AES-256-GCM, random IV). Never plaintext.
CREATE TABLE oauth_tokens (
  platform          TEXT PRIMARY KEY,
  access_token_enc  TEXT    NOT NULL,
  expires_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

-- Shared rate-limit state: after a 429 the whole platform is paused (for every job,
-- every worker) until blocked_until, so we never hammer a limited API.
CREATE TABLE platform_limits (
  platform      TEXT PRIMARY KEY,
  blocked_until INTEGER NOT NULL
);

-- Webhook de-duplication: platforms deliver at-least-once.
CREATE TABLE webhook_events (
  event_id       TEXT PRIMARY KEY,
  social_post_id INTEGER,
  type           TEXT NOT NULL,
  outcome        TEXT NOT NULL,
  received_at    INTEGER NOT NULL
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

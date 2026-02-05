BEGIN;

CREATE TABLE IF NOT EXISTS app_kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- OAuth tokens (broadcaster user token) needed for channel.update
CREATE TABLE IF NOT EXISTS oauth_tokens (
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  scope TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (provider, subject)
);

CREATE TABLE IF NOT EXISTS streams (
  stream_id TEXT PRIMARY KEY,
  broadcaster_id TEXT NOT NULL,
  broadcaster_login TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ NULL,
  ended_reason TEXT NULL
);

CREATE TABLE IF NOT EXISTS category_segments (
  id BIGSERIAL PRIMARY KEY,
  stream_id TEXT NOT NULL REFERENCES streams(stream_id) ON DELETE CASCADE,
  category_id TEXT NULL,
  category_name TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ NULL,
  duration_seconds BIGINT NULL,
  UNIQUE (stream_id, started_at, category_name)
);

CREATE TABLE IF NOT EXISTS events_raw (
  id BIGSERIAL PRIMARY KEY,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL
);

-- Manual baseline snapshot (status quo) you can insert by hand
CREATE TABLE IF NOT EXISTS baseline_games (
  id BIGSERIAL PRIMARY KEY,
  inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source TEXT NOT NULL, -- e.g. "twitchtracker_manual"
  game_name TEXT NOT NULL,
  total_hours NUMERIC NULL,
  last_seen_date DATE NULL,
  note TEXT NULL
);

COMMIT;


-- Oura/Whoop logins, now held by AyuOS itself (previously by the Docker
-- wearables backend). Tokens are encrypted with a key from the Keychain
-- (shared/crypto.ts); `last_synced_at` is each provider's resume point.
CREATE TABLE IF NOT EXISTS ops.wearable_connections (
  provider          TEXT PRIMARY KEY,
  access_token_enc  TEXT NOT NULL,
  refresh_token_enc TEXT,
  token_expires_at  TIMESTAMPTZ,
  scope             TEXT,
  provider_user_id  TEXT,
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'needs_reconnect')),
  connected_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_synced_at    TIMESTAMPTZ,
  last_error        TEXT
);

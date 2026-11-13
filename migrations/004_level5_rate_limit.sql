-- Level 5: one row per booking attempt, per email. Rows older than the
-- 60-second window are deleted as new attempts arrive.
CREATE TABLE IF NOT EXISTS rate_attempts (
  id    bigserial PRIMARY KEY,
  email text        NOT NULL,
  at    timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS rate_attempts_email_at_idx ON rate_attempts (email, at);

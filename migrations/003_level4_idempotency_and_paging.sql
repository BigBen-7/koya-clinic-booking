-- Level 4: remembered Idempotency-Key results, and an index for paging.

-- One row per key that produced a 201. `fingerprint` is a hash of the request
-- body, `response` is the exact booking returned the first time.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key         text PRIMARY KEY,
  fingerprint text        NOT NULL,
  status_code integer     NOT NULL,
  response    json        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Matches the paging query: WHERE email = ? ORDER BY created_at, id.
CREATE INDEX IF NOT EXISTS bookings_email_created_idx ON bookings (email, created_at, id);

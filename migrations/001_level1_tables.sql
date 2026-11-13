-- Level 1: slots and bookings.
-- All migrations are idempotent (IF NOT EXISTS) and run in order at startup.

CREATE TABLE IF NOT EXISTS slots (
  id        text PRIMARY KEY,
  provider  text        NOT NULL,
  start_at  timestamptz NOT NULL,
  end_at    timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS slots_start_idx ON slots (start_at, id);

CREATE TABLE IF NOT EXISTS bookings (
  id         text PRIMARY KEY,
  slot_id    text        NOT NULL REFERENCES slots (id),
  name       text        NOT NULL,
  email      text        NOT NULL,
  status     text        NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

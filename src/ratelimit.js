// Level 5: at most 5 booking attempts per email per rolling 60 seconds.
// State lives in Postgres, so it survives restarts and works across instances.
const { tx } = require("./db");
const { HttpError } = require("./errors");

const MAX_ATTEMPTS = 5;
const WINDOW_SECONDS = 60;

// Record an attempt for `email`, or throw 429 if it already used its 5.
// A rejected (429) attempt is not recorded, so waiting Retry-After seconds
// always works.
async function recordAttempt(email) {
  const retryAfter = await tx(async (db) => {
    // One lock per email: concurrent requests for the same email take turns,
    // so the count-then-insert below can't let a 6th attempt slip through.
    // Other emails use other locks and are never blocked.
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`rate:${email}`]);

    // Housekeeping: forget this email's attempts that left the window.
    await db.query(
      `DELETE FROM rate_attempts WHERE email = $1 AND at <= clock_timestamp() - make_interval(secs => $2)`,
      [email, WINDOW_SECONDS]
    );

    // Attempts still inside the window; `oldest` tells us when room frees up.
    const { rows } = await db.query(
      `SELECT count(*)::int AS n,
              CEIL(EXTRACT(EPOCH FROM (min(at) + make_interval(secs => $2) - clock_timestamp())))::int AS wait
         FROM rate_attempts WHERE email = $1`,
      [email, WINDOW_SECONDS]
    );
    if (rows[0].n >= MAX_ATTEMPTS) return Math.max(1, rows[0].wait);

    await db.query("INSERT INTO rate_attempts (email) VALUES ($1)", [email]);
    return 0;
  });

  if (retryAfter > 0) {
    throw new HttpError(429, "too many booking attempts for this email, try again later", {
      "Retry-After": String(retryAfter),
    });
  }
}

module.exports = { recordAttempt };

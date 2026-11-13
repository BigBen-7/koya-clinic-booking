// Slots: POST /reset (replace all slots) and GET /slots.
const { pool, tx } = require("./db");
const { HttpError } = require("./errors");

// Output format: "2026-12-10T09:00:00Z" (milliseconds only when non-zero).
function iso(date) {
  return date.toISOString().replace(".000Z", "Z");
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

// Check the slots array sent to /reset and return clean rows.
function parseSlots(body) {
  if (!body || typeof body !== "object" || !Array.isArray(body.slots)) {
    throw new HttpError(400, "slots must be an array");
  }
  const seen = new Set();
  return body.slots.map((s, i) => {
    const bad = (msg) => new HttpError(400, `slots[${i}]: ${msg}`);
    if (!s || typeof s !== "object") throw bad("must be an object");
    for (const f of ["id", "provider", "start", "end"]) {
      if (typeof s[f] !== "string" || s[f].trim() === "") throw bad(`${f} is required`);
    }
    if (!ISO_DATE.test(s.start) || Number.isNaN(Date.parse(s.start))) throw bad("start is not a valid date-time");
    if (!ISO_DATE.test(s.end) || Number.isNaN(Date.parse(s.end))) throw bad("end is not a valid date-time");
    if (seen.has(s.id)) throw bad(`duplicate id ${s.id}`);
    seen.add(s.id);
    return { id: s.id, provider: s.provider, start: new Date(s.start), end: new Date(s.end) };
  });
}

// POST /reset: wipe bookings and replace every slot, in one transaction.
async function reset(body) {
  const slots = parseSlots(body);
  await tx(async (db) => {
    await db.query("DELETE FROM idempotency_keys");
    await db.query("DELETE FROM bookings");
    await db.query("DELETE FROM slots");
    if (slots.length > 0) {
      await db.query(
        `INSERT INTO slots (id, provider, start_at, end_at)
         SELECT * FROM unnest($1::text[], $2::text[], $3::timestamptz[], $4::timestamptz[])`,
        [slots.map((s) => s.id), slots.map((s) => s.provider), slots.map((s) => s.start), slots.map((s) => s.end)]
      );
    }
  });
}

// GET /slots: earliest start first, optional exact-match provider filter.
async function listSlots(provider) {
  const { rows } = await pool.query(
    `SELECT s.id, s.provider, s.start_at, s.end_at,
            NOT EXISTS (SELECT 1 FROM bookings b WHERE b.slot_id = s.id AND b.status = 'confirmed') AS available
       FROM slots s
      WHERE ($1::text IS NULL OR s.provider = $1)
      ORDER BY s.start_at, s.id`,
    [provider ?? null]
  );
  return rows.map((r) => ({
    id: r.id,
    provider: r.provider,
    start: iso(r.start_at),
    end: iso(r.end_at),
    available: r.available,
  }));
}

module.exports = { reset, listSlots };

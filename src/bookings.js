// Bookings: create and look up.
const crypto = require("crypto");
const { pool, tx } = require("./db");
const { HttpError } = require("./errors");
const { normalizeEmail } = require("./validate");

// created_at is returned with microseconds so ordering and cursors stay exact.
const COLUMNS = `id, slot_id, name, email, status,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_iso`;

function toBooking(row) {
  return {
    id: row.id,
    slot_id: row.slot_id,
    name: row.name,
    email: row.email,
    status: row.status,
    created_at: row.created_at_iso,
  };
}

// Same JSON, same text: object keys are sorted so key order doesn't matter.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(body) {
  return crypto.createHash("sha256").update(canonical(body)).digest("hex");
}

// POST /bookings: book a slot. `input` is already validated and cleaned;
// `rawBody` and `idemKey` (the Idempotency-Key header, optional) are Level 4.
async function createBooking(input, rawBody, idemKey) {
  return tx(async (db) => {
    // Level 4: claim the key inside the booking transaction. The advisory lock
    // makes parallel requests with the same key take turns, so the second one
    // sees the stored result instead of booking again.
    if (idemKey) {
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`idem:${idemKey}`]);
      const prior = await db.query(
        "SELECT fingerprint, status_code, response FROM idempotency_keys WHERE key = $1",
        [idemKey]
      );
      if (prior.rowCount > 0) {
        if (prior.rows[0].fingerprint !== fingerprint(rawBody)) {
          throw new HttpError(422, "Idempotency-Key was already used with a different request body");
        }
        return { status: prior.rows[0].status_code, body: prior.rows[0].response };
      }
    }
    const slot = await db.query(
      "SELECT start_at <= clock_timestamp() AS started FROM slots WHERE id = $1",
      [input.slot_id]
    );
    if (slot.rowCount === 0) throw new HttpError(404, "slot not found");
    if (slot.rows[0].started) throw new HttpError(400, "slot has already started");
    let rows;
    try {
      ({ rows } = await db.query(
        `INSERT INTO bookings (id, slot_id, name, email) VALUES ($1, $2, $3, $4) RETURNING ${COLUMNS}`,
        [crypto.randomUUID(), input.slot_id, input.name, input.email]
      ));
    } catch (err) {
      // Level 3: unique_violation from one_confirmed_booking_per_slot. When
      // requests race, the database lets one INSERT win and rejects the rest.
      if (err.code === "23505") throw new HttpError(409, "slot already booked");
      throw err;
    }
    const booking = toBooking(rows[0]);
    // Stored in the same transaction as the booking: both happen or neither.
    // A failed attempt (404, 400, 409) rolls back, so it never uses up the key.
    if (idemKey) {
      await db.query(
        "INSERT INTO idempotency_keys (key, fingerprint, status_code, response) VALUES ($1, $2, 201, $3)",
        [idemKey, fingerprint(rawBody), booking]
      );
    }
    return { status: 201, body: booking };
  });
}

// GET /bookings/{id} (Level 1).
async function getBooking(id) {
  const { rows } = await pool.query(`SELECT ${COLUMNS} FROM bookings WHERE id = $1`, [id]);
  if (rows.length === 0) throw new HttpError(404, "booking not found");
  return toBooking(rows[0]);
}

// GET /bookings?email=&limit=&cursor= (Level 4): one person's bookings, oldest
// first, paged with a cursor. The cursor is the (created_at, id) of the last
// row on the previous page, so pages stay correct even as new bookings arrive.
async function listBookings(query) {
  const email = normalizeEmail(query.email);
  if (!email) throw new HttpError(400, "email is required and must be valid");

  let limit = 10;
  if (query.limit !== undefined) {
    if (typeof query.limit !== "string" || !/^\d+$/.test(query.limit)) throw new HttpError(400, "limit must be an integer from 1 to 50");
    limit = Number(query.limit);
    if (limit < 1 || limit > 50) throw new HttpError(400, "limit must be an integer from 1 to 50");
  }

  let after = null;
  if (query.cursor !== undefined) after = decodeCursor(query.cursor);

  // Fetch one extra row to learn whether another page exists.
  const { rows } = await pool.query(
    `SELECT ${COLUMNS} FROM bookings
      WHERE email = $1 AND ($2::timestamptz IS NULL OR (created_at, id) > ($2::timestamptz, $3))
      ORDER BY created_at, id
      LIMIT $4`,
    [email, after ? after.created_at : null, after ? after.id : null, limit + 1]
  );
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    bookings: page.map(toBooking),
    next_cursor: rows.length > limit ? encodeCursor(last.created_at_iso, last.id) : null,
  };
}

function encodeCursor(created_at, id) {
  return Buffer.from(JSON.stringify([created_at, id])).toString("base64url");
}

function decodeCursor(cursor) {
  const bad = new HttpError(400, "cursor is not valid");
  if (typeof cursor !== "string" || cursor === "") throw bad;
  try {
    const [created_at, id] = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof id !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(created_at)) throw bad;
    return { created_at, id };
  } catch {
    throw bad;
  }
}

// DELETE /bookings/{id} (Level 3): cancel and free the slot.
// One conditional UPDATE does the check and the change atomically, so two
// simultaneous cancels cannot both succeed.
async function cancelBooking(id) {
  const { rows } = await pool.query(
    `UPDATE bookings SET status = 'cancelled' WHERE id = $1 AND status = 'confirmed' RETURNING ${COLUMNS}`,
    [id]
  );
  if (rows.length > 0) return toBooking(rows[0]);
  const exists = await pool.query("SELECT 1 FROM bookings WHERE id = $1", [id]);
  if (exists.rowCount === 0) throw new HttpError(404, "booking not found");
  throw new HttpError(409, "booking already cancelled");
}

module.exports = { createBooking, getBooking, listBookings, cancelBooking, toBooking, COLUMNS };

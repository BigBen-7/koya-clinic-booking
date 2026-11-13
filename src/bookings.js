// Bookings: create and look up.
const crypto = require("crypto");
const { pool, tx } = require("./db");
const { HttpError } = require("./errors");

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

// POST /bookings: book a slot. `input` is already validated and cleaned.
async function createBooking(input) {
  return tx(async (db) => {
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
    return { status: 201, body: toBooking(rows[0]) };
  });
}

// GET /bookings/{id} (Level 1).
async function getBooking(id) {
  const { rows } = await pool.query(`SELECT ${COLUMNS} FROM bookings WHERE id = $1`, [id]);
  if (rows.length === 0) throw new HttpError(404, "booking not found");
  return toBooking(rows[0]);
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

module.exports = { createBooking, getBooking, cancelBooking, toBooking, COLUMNS };

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
    const { rows } = await db.query(
      `INSERT INTO bookings (id, slot_id, name, email) VALUES ($1, $2, $3, $4) RETURNING ${COLUMNS}`,
      [crypto.randomUUID(), input.slot_id, input.name, input.email]
    );
    return { status: 201, body: toBooking(rows[0]) };
  });
}

// GET /bookings/{id} (Level 1).
async function getBooking(id) {
  const { rows } = await pool.query(`SELECT ${COLUMNS} FROM bookings WHERE id = $1`, [id]);
  if (rows.length === 0) throw new HttpError(404, "booking not found");
  return toBooking(rows[0]);
}

module.exports = { createBooking, getBooking, toBooking, COLUMNS };

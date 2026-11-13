// Level 2: input checks for POST /bookings.
const { HttpError } = require("./errors");

// Deliberately simple: something@something.tld with no spaces.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_NAME = 200;
const MAX_EMAIL = 254;

// Trimmed, lower-cased email if it looks usable, otherwise null.
function normalizeEmail(value) {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length > 0 && email.length <= MAX_EMAIL && EMAIL.test(email) ? email : null;
}

// Returns clean { slot_id, name, email } or throws 400. Fields are checked in
// the order slot_id, name, email.
function validateBooking(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "request body must be a JSON object");
  }
  const need = (field) => {
    const v = body[field];
    if (typeof v !== "string" || v.trim() === "") throw new HttpError(400, `${field} is required`);
    return v.trim();
  };
  const slot_id = need("slot_id");
  const name = need("name");
  if (name.length > MAX_NAME) throw new HttpError(400, `name must be at most ${MAX_NAME} characters`);
  const rawEmail = need("email");
  const email = normalizeEmail(rawEmail);
  if (!email) throw new HttpError(400, "email is not valid");
  return { slot_id, name, email };
}

module.exports = { validateBooking, normalizeEmail };

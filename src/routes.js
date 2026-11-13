// The API routes from SPEC.json. The same router is mounted twice in server.js:
// once behind the API key (the real API) and once for the web page under /web.
const express = require("express");
const { HttpError } = require("./errors");
const slots = require("./slots");
const bookings = require("./bookings");
const { validateBooking, normalizeEmail } = require("./validate");
const { recordAttempt } = require("./ratelimit");

// Level 4: optional Idempotency-Key header (blank counts as absent).
function idempotencyKey(req) {
  const key = (req.get("idempotency-key") || "").trim();
  if (key.length > 255) throw new HttpError(400, "Idempotency-Key is too long");
  return key || null;
}

const router = express.Router();
router.use(express.json({ limit: "5mb" }));

router.post("/reset", async (req, res) => {
  await slots.reset(req.body);
  res.status(200).json({ ok: true });
});

router.get("/slots", async (req, res) => {
  const provider = typeof req.query.provider === "string" ? req.query.provider : undefined;
  res.json({ slots: await slots.listSlots(provider) });
});

router.post("/bookings", async (req, res) => {
  // Level 5: every authenticated attempt with a usable email counts, whatever
  // its outcome, so spam is limited even when the bookings fail. This runs
  // before validation so the 6th attempt always gets 429.
  const email = normalizeEmail(req.body && req.body.email);
  if (email) await recordAttempt(email);

  const input = validateBooking(req.body);
  const idemKey = idempotencyKey(req);
  const result = await bookings.createBooking(input, req.body, idemKey);
  res.status(result.status).json(result.body);
});

router.get("/bookings", async (req, res) => {
  res.json(await bookings.listBookings(req.query));
});

router.get("/bookings/:id", async (req, res) => {
  res.json(await bookings.getBooking(req.params.id));
});

router.delete("/bookings/:id", async (req, res) => {
  res.json(await bookings.cancelBooking(req.params.id));
});

module.exports = { router };

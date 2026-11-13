// Level 2: only requests carrying the right X-API-Key header get in.
const crypto = require("crypto");
const { HttpError } = require("./errors");

// Compare SHA-256 digests with timingSafeEqual so the check takes the same
// time for every wrong key (no leaking how many characters matched).
function digest(value) {
  return crypto.createHash("sha256").update(String(value)).digest();
}

function requireKey(req, res, next) {
  const expected = process.env.API_KEY;
  const given = req.get("x-api-key");
  if (!expected || !given || !crypto.timingSafeEqual(digest(given), digest(expected))) {
    return next(new HttpError(401, "missing or invalid API key"));
  }
  next();
}

module.exports = { requireKey };

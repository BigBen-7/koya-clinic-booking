// Clinic booking API + web page. Config comes from env vars only:
// API_KEY, DATABASE_URL, PORT.
const path = require("path");
const express = require("express");
const { migrate } = require("./db");
const { HttpError } = require("./errors");
const { requireKey } = require("./auth");
const { router } = require("./routes");

const app = express();
app.disable("x-powered-by");

// --- Web page -------------------------------------------------------------
// The page is public and never holds the API key. It calls /web/..., and this
// guard adds the key on the server before the request reaches the API router.
// Only these four calls are allowed. /reset and the by-email booking list
// (which would expose other people's bookings) are not reachable from the page.
const WEB_ALLOWED = [
  ["GET", /^\/slots$/],
  ["POST", /^\/bookings$/],
  ["GET", /^\/bookings\/[^/]+$/],
  ["DELETE", /^\/bookings\/[^/]+$/],
];

function webGuard(req, res, next) {
  const allowed = WEB_ALLOWED.some(([method, pattern]) => method === req.method && pattern.test(req.path));
  if (!allowed) return next(new HttpError(404, "not found"));
  req.headers["x-api-key"] = process.env.API_KEY;
  next();
}

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "index.html")));
app.use("/web", webGuard, requireKey, router);

// --- The API --------------------------------------------------------------
// Level 2: the key is checked before anything else, including the JSON body.
app.use(requireKey, router);

app.use((req, res) => res.status(404).json({ error: "not found" }));

// Every error leaves as { "error": message }.
app.use((err, req, res, next) => {
  if (err instanceof HttpError) {
    return res.status(err.status).set(err.headers).json({ error: err.message });
  }
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "invalid JSON" });
  if (err.type === "entity.too.large") return res.status(413).json({ error: "request body too large" });
  console.error(err);
  res.status(500).json({ error: "internal server error" });
});

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  if (!process.env.API_KEY) throw new Error("API_KEY is required");
  await migrate();
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => console.log(`listening on ${port}`));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { app };

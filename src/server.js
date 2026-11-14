// Clinic booking API + web page. Config comes from env vars only:
// API_KEY, DATABASE_URL, PORT.
const path = require("path");
const express = require("express");
const { migrate, isDbUnavailable } = require("./db");
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

// Every error leaves as { "error": message }, and never carries a stack trace,
// SQL or other internals. Only the message of a deliberate 4xx is shown; anything
// unexpected is logged here (stack only, no request data) and answered generically.
function logError(req, err) {
  console.error(`${req.method} ${req.path}:`, err && err.stack ? err.stack : String(err));
}

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof HttpError) {
    return res.status(err.status).set(err.headers).json({ error: err.message });
  }
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "invalid JSON" });
  if (err.type === "entity.too.large") return res.status(413).json({ error: "request body too large" });
  if (err instanceof URIError) return res.status(400).json({ error: "malformed URL" }); // bad %-escape in the path
  // Other client mistakes raised by Express itself (bad %-escape in the URL,
  // unsupported Content-Encoding, ...) carry their own 4xx status and a safe message.
  const status = err.status || err.statusCode;
  if (Number.isInteger(status) && status >= 400 && status < 500 && err.expose) {
    return res.status(status).json({ error: err.message });
  }
  logError(req, err);
  // Database unreachable: tell the client to retry rather than report a bug.
  if (isDbUnavailable(err)) {
    return res.status(503).set("Retry-After", "5").json({ error: "service temporarily unavailable, please try again shortly" });
  }
  res.status(500).json({ error: "internal server error" });
});

// The database may not be reachable yet when the app starts (it is waking up,
// or starting alongside us). Retry for about a minute, then exit with a clear
// message. The server only starts listening after migrations succeed, so there
// is never a half-initialised app taking requests.
async function migrateWithRetry(attempts = 12, delayMs = 5000) {
  for (let i = 1; ; i++) {
    try {
      return await migrate();
    } catch (err) {
      if (!isDbUnavailable(err) || i >= attempts) throw err;
      console.error(`database not reachable (attempt ${i}/${attempts}): ${err.message}. Retrying in ${delayMs / 1000}s`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  if (!process.env.API_KEY) throw new Error("API_KEY is required");
  await migrateWithRetry();
  const port = Number(process.env.PORT) || 3000;
  const server = app.listen(port, () => console.log(`listening on ${port}`));

  // Node answers a malformed or oversized request (for example a header over
  // 16 KB) itself, before Express runs, with an empty body. Make that JSON too.
  server.on("clientError", (err, socket) => {
    if (!socket.writable) return socket.destroy();
    const status = err.code === "HPE_HEADER_OVERFLOW" ? 431 : 400;
    const message = status === 431 ? "request headers too large" : "bad request";
    const body = JSON.stringify({ error: message });
    socket.end(`HTTP/1.1 ${status} ${status === 431 ? "Request Header Fields Too Large" : "Bad Request"}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { app };

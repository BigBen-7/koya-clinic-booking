// Clinic booking API. Config comes from env vars only: DATABASE_URL, PORT.
const express = require("express");
const { migrate } = require("./db");
const { HttpError } = require("./errors");
const slots = require("./slots");
const bookings = require("./bookings");
const { requireKey } = require("./auth");
const { validateBooking } = require("./validate");

const app = express();
app.disable("x-powered-by");

// Level 2: the key is checked before anything else, including the JSON body.
app.use(requireKey);
app.use(express.json({ limit: "5mb" }));

app.post("/reset", async (req, res) => {
  await slots.reset(req.body);
  res.status(200).json({ ok: true });
});

app.get("/slots", async (req, res) => {
  const provider = typeof req.query.provider === "string" ? req.query.provider : undefined;
  res.json({ slots: await slots.listSlots(provider) });
});

app.post("/bookings", async (req, res) => {
  const input = validateBooking(req.body);
  const result = await bookings.createBooking(input);
  res.status(result.status).json(result.body);
});

app.get("/bookings/:id", async (req, res) => {
  res.json(await bookings.getBooking(req.params.id));
});

app.delete("/bookings/:id", async (req, res) => {
  res.json(await bookings.cancelBooking(req.params.id));
});

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

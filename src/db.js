// Database access: one connection pool, a transaction helper and the migration runner.
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

// connectionTimeoutMillis: when the database is down, a request fails in 5 s
// instead of hanging. statement_timeout: a stuck query is cancelled by Postgres.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  connectionTimeoutMillis: 5000,
  statement_timeout: 15000,
});

// An idle connection can be dropped (database restart, network blip). Without
// this listener that 'error' event is unhandled and kills the whole process.
// The pool discards the dead connection and opens a new one when needed.
pool.on("error", (err) => {
  console.error("idle database connection error:", err.message);
});

// True when the failure means "the database is not reachable right now"
// (as opposed to a bug or bad input). The error handler turns these into 503.
const DOWN_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "57P01", "57P02", "57P03", "57014", "53300"]);
function isDbUnavailable(err) {
  if (!err) return false;
  if (DOWN_CODES.has(err.code)) return true;
  if (typeof err.code === "string" && err.code.startsWith("08")) return true; // connection exceptions
  if (err.errors && Array.isArray(err.errors)) return err.errors.some(isDbUnavailable); // AggregateError (IPv4+IPv6 both refused)
  return /timeout exceeded when trying to connect|Connection terminated|Client has encountered a connection error|the database system is (starting up|shutting down)/i.test(err.message || "");
}

// Run fn(client) inside BEGIN/COMMIT. Any thrown error rolls back and is re-thrown.
async function tx(fn) {
  const client = await pool.connect();
  // While a client is checked out the pool has no error listener for it, so a
  // dropped connection between two queries would crash the process.
  const onClientError = (err) => console.error("database connection error:", err.message);
  client.on("error", onClientError);
  let broken = false;
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* the connection is already broken; nothing more to do */
    }
    broken = isDbUnavailable(err);
    throw err;
  } finally {
    client.removeListener("error", onClientError);
    client.release(broken); // true: destroy the connection instead of reusing it
  }
}

// Apply every migrations/*.sql file in name order. They are idempotent, and a
// transaction-level advisory lock stops two starting instances from racing.
async function migrate() {
  const dir = path.join(__dirname, "..", "migrations");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  await tx(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(727274)");
    for (const file of files) {
      await client.query(fs.readFileSync(path.join(dir, file), "utf8"));
    }
  });
}

module.exports = { pool, tx, migrate, isDbUnavailable };

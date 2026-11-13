// Database access: one connection pool, a transaction helper and the migration runner.
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });

// Run fn(client) inside BEGIN/COMMIT. Any thrown error rolls back and is re-thrown.
async function tx(fn) {
  const client = await pool.connect();
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
    throw err;
  } finally {
    client.release();
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

module.exports = { pool, tx, migrate };

// Demo data for the web page: 30-minute slots for two providers over the next
// 7 days. Like POST /reset, this REPLACES all slots and deletes all bookings.
// Run:  DATABASE_URL=... npm run seed
const { migrate, pool } = require("../src/db");
const { reset } = require("../src/slots");

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  await migrate();

  const providers = ["Dr Ade", "Dr Bello"];
  const slots = [];
  const day = new Date();
  day.setUTCHours(0, 0, 0, 0);
  for (let d = 1; d <= 7; d++) {
    for (const provider of providers) {
      for (let half = 0; half < 8; half++) {
        // 09:00 to 13:00 UTC in 30-minute steps
        const start = new Date(day.getTime() + d * 86400000 + (9 * 60 + half * 30) * 60000);
        const end = new Date(start.getTime() + 30 * 60000);
        slots.push({
          id: `s${slots.length + 1}`,
          provider,
          start: start.toISOString(),
          end: end.toISOString(),
        });
      }
    }
  }
  await reset({ slots });
  console.log(`seeded ${slots.length} slots`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

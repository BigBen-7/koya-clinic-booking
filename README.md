# Clinic booking API and web page

Koya Academy Cohort 4, Task 1. An Express + PostgreSQL API that lets patients book appointment slots, and a small web page that uses it. The contract is `SPEC.json` (OpenAPI 3.0.3); `TASK.md` is the task text; `SPEC_NOTES.md` is a readable summary of the spec.

All five levels are implemented. `npm run test:e2e` checks every level against a running server.

## Run it locally

You need Node 20+ and a PostgreSQL database (local, or a free Neon project).

```bash
npm install
export API_KEY=choose-a-key
export DATABASE_URL=postgres://user:password@localhost:5432/clinic
export PORT=3000
npm start                   # creates the tables on first start
# Or keep the values in a git-ignored .env file (copy .env.example) and run:
#   node --env-file=.env src/server.js
npm run seed                # optional: demo slots for the web page (replaces all slots)
```

Open <http://localhost:3000> for the web page. The API is at the same address.

Test it (this calls `POST /reset`, which **deletes all bookings and replaces all slots**, so never point it at data you want to keep):

```bash
BASE_URL=http://localhost:3000 API_KEY=choose-a-key npm run test:e2e
```

### Environment variables

| Variable | Meaning |
|---|---|
| `API_KEY` | The key callers must send in the `X-API-Key` header. The server refuses to start without it. |
| `DATABASE_URL` | PostgreSQL connection string (Neon: include `?sslmode=require`). |
| `PORT` | Port to listen on (default 3000; Render sets it for you). |

No secrets are stored in the repo. `.env` is git-ignored.

## Endpoints (from the spec)

| Endpoint | Level | Notes |
|---|---|---|
| `POST /reset` | 1 | Replaces all slots, deletes all bookings, idempotency keys and rate-limit counters |
| `GET /slots[?provider=]` | 1 | Earliest first, with `available` |
| `POST /bookings` | 1-5 | 201 / 400 / 404 / 409 / 422 / 429 |
| `GET /bookings/{id}` | 1 | 200 / 404 |
| `DELETE /bookings/{id}` | 3 | 200 / 404 / 409 |
| `GET /bookings?email=&limit=&cursor=` | 4 | Cursor paging, oldest first |

## Where each level lives

| Level | What | File and function |
|---|---|---|
| 1 | Routes | `src/routes.js` (`router`) |
| 1 | List slots, replace slots | `src/slots.js` (`listSlots`, `reset`) |
| 1 | Book, look up | `src/bookings.js` (`createBooking`, `getBooking`) |
| 1 | Tables | `migrations/001_level1_tables.sql` |
| 2 | API key check | `src/auth.js` (`requireKey`), applied in `src/server.js` |
| 2 | Field validation, trimming, lower-casing | `src/validate.js` (`validateBooking`, `normalizeEmail`) |
| 2 | Unknown slot (404), slot already started (400) | `src/bookings.js` (`createBooking`) |
| 3 | No double booking | `migrations/002_level3_one_booking_per_slot.sql`; `src/bookings.js` (`createBooking`, the `23505` handler) |
| 3 | Cancel | `src/bookings.js` (`cancelBooking`) |
| 4 | Idempotency | `migrations/003_level4_idempotency_and_paging.sql`; `src/bookings.js` (`createBooking`, `fingerprint`); `src/routes.js` (`idempotencyKey`) |
| 4 | Paging | `src/bookings.js` (`listBookings`, `encodeCursor`, `decodeCursor`) |
| 5 | Rate limit | `migrations/004_level5_rate_limit.sql`; `src/ratelimit.js` (`recordAttempt`); called in `src/routes.js` |
| Page | Web page and its server routes | `public/index.html`; `src/server.js` (`webGuard`) |

## How the database enforces Levels 3 to 5

The rules are enforced by Postgres, not by code that could race.

- **Level 3, no double booking.** A *partial unique index*, `one_confirmed_booking_per_slot ON bookings (slot_id) WHERE status = 'confirmed'`, means two confirmed bookings for one slot cannot exist. When 20 requests arrive together, all 20 try to `INSERT`; Postgres lets one succeed and the others fail with a unique violation, which the code turns into `409`. There is no "check, then insert" gap to slip through. Cancelling sets `status = 'cancelled'`, which takes the row out of the index, so the slot is free again. Cancel is one conditional `UPDATE ... WHERE status = 'confirmed'`, so two simultaneous cancels cannot both succeed.
- **Level 4, idempotency.** The `Idempotency-Key` is claimed *inside the booking transaction*: the transaction first takes a Postgres advisory lock derived from the key, then looks the key up in `idempotency_keys`. Parallel retries with the same key therefore take turns; the first books and stores its response in the same transaction, and the rest find that stored response and replay it (same status, same `id`). A request that fails (400, 404, 409) rolls back, so it never stores a key. A body fingerprint (SHA-256 of the canonical JSON) is stored with the key; the same key with a different body returns 422.
- **Level 4, paging.** Pages are ordered by `(created_at, id)` with an index on `(email, created_at, id)`. The cursor is the `(created_at, id)` of the last row returned, so new bookings arriving between pages never cause repeats or gaps (unlike `OFFSET`). `created_at` keeps microsecond precision so the cursor is exact.
- **Level 5, rate limit.** Each attempt is a row in `rate_attempts`. In one short transaction, a per-email advisory lock is taken, old rows are deleted, the rows in the last 60 seconds are counted, and the attempt is inserted only if there are fewer than 5. Because of the lock, 12 simultaneous attempts for one email always give exactly 5 allowed and 7 rejected, and other emails are never blocked. State lives in Postgres, so it survives restarts and works with more than one server instance.

## Design decisions

- **Plain SQL with `pg`**, no ORM: every rule above is visible in the SQL.
- **Migrations are idempotent files** in `migrations/`, applied in order at startup inside a transaction guarded by an advisory lock. Levels 1, 3, 4 and 5 each added one migration file.
- **The web page never holds the API key.** The page calls `/web/...`, a small public set of routes: `GET /web/slots`, `POST /web/bookings`, `GET /web/bookings/{id}`, `DELETE /web/bookings/{id}`. `webGuard` in `src/server.js` allows only those four calls, adds the key on the server, and hands the request to the same router as the real API. `/reset` and the by-email booking list are not reachable from the page. The real API paths still return 401 without the key. The consequence: anyone who can open the page can book through it. That is what a public booking page is, and rate limiting still applies to every booking.
- **The page sends an `Idempotency-Key` per attempt.** The key is kept while the slot, name and email stay the same, so pressing the button again after a failure can never double-book.
- **Page text is added with `textContent`**, never `innerHTML`, so a name like `<script>` cannot inject markup.
- **Timing-safe key comparison** (`crypto.timingSafeEqual` on SHA-256 digests).
- **Two dependencies only:** `express` and `pg`. The tests use Node's built-in `fetch`.

## Assumptions

Where `SPEC.json` is explicit, it wins. Where it is silent, this is what I did (the numbering follows the open questions in `SPEC_NOTES.md`).

**Order of checks and validation**
1. Order for `POST /bookings`: 401, then rate limit (see 2), then field validation (400), then slot not found (404), then slot already started (400), then conflict (409). Fields are checked in the order `slot_id`, `name`, `email`.
2. "Slot already started" means `start <= now`, using the database clock.
3. A valid email means `something@something.tld` with no spaces (max 254 characters); `name` has a 200-character limit. Non-string fields (for example `name: 42`) are 400. Malformed JSON is 400. Error messages are short lower-case sentences; the spec gives only `"slot not found"`.
4. The API key is checked before the body is parsed, so bad JSON without a key is 401.

**Rate limit (Level 5)**
5. Every authenticated `POST /bookings` with a *usable* email counts as an attempt, whatever its outcome (201, 400, 404, 409, 422 or a replay). Requests with a missing or wrong key (401) and requests with no usable email do not count, because there is no email to count against.
6. The limit is checked before validation, so the 6th attempt always gets 429, even if it would also have been a 400.
7. The window is a rolling 60 seconds, per email (trimmed and lower-cased). A rejected (429) attempt is not recorded, so waiting `Retry-After` always works. `Retry-After` is the whole seconds (rounded up, at least 1) until the oldest counted attempt leaves the window.
8. An idempotent replay counts as an attempt like any other request (see "Double-check" in the final report).

**Idempotency (Level 4)**
9. The key is global (not per email). Only successful 201 responses are stored; errors are never stored and never use up a key.
10. "Same body" compares the parsed JSON as sent, with object keys in any order. It does not trim or lower-case first.
11. A blank `Idempotency-Key` header is treated as no key. Keys over 255 characters are 400. Keys are never expired.

**Reset, listing and misc**
12. `POST /reset` requires the API key and returns `200 {"ok": true}` (the spec gives no response body). It validates the `slots` array (400 on a bad shape, a bad date-time or a duplicate id) and, in one transaction, deletes all bookings, idempotency keys and rate-limit counters and replaces all slots. Slots keep their given times, normalised to UTC (`...Z`).
13. `GET /bookings`: a missing or invalid `email`, `limit` or `cursor` is 400. Cancelled bookings are included with `status: "cancelled"`. The email match ignores case. Default `limit` is 10.
14. Booking `id` is a random UUID. `created_at` is an ISO 8601 UTC timestamp with microseconds. The cursor is an opaque base64url string.
15. Cancelling is allowed at any time, including after the slot has started. After a cancel, the slot can be booked again.
16. Unknown routes return 404 `{"error": "not found"}` (after the 401 check). Request bodies are limited to 5 MB.
17. The web page and its `/web` routes are public (no key needed); everything else needs the key.

## Project layout

```
src/server.js      app setup, /web guard, error handling
src/routes.js      the API routes from the spec
src/slots.js       POST /reset, GET /slots
src/bookings.js    create, get, list, cancel
src/validate.js    input checks
src/auth.js        API key check
src/ratelimit.js   Level 5
src/db.js          pool, transactions, migrations runner
migrations/        001 tables, 002 unique index, 003 idempotency + paging, 004 rate limit
public/index.html  the web page
scripts/seed.js    demo slots
test/e2e.js        end-to-end tests
```

See `DEPLOY.md` for the Neon + Render checklist and `WALKTHROUGH.md` for the recording outline.

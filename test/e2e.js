// End-to-end tests. They talk to a running server over HTTP.
//
//   BASE_URL=http://localhost:3000 API_KEY=yourkey npm run test:e2e
//
// WARNING: these call POST /reset, which deletes every booking and replaces
// every slot. Never point them at a database that holds data you want to keep.
//
// Each test uses its own slots and its own email addresses, because the API
// (correctly) limits any one email to 5 booking attempts per minute.

const BASE_URL = (process.env.BASE_URL || "").replace(/\/+$/, "");
const API_KEY = process.env.API_KEY;
if (!BASE_URL || !API_KEY) {
  console.error("Set BASE_URL and API_KEY, for example:\n  BASE_URL=http://localhost:3000 API_KEY=secret npm run test:e2e");
  process.exit(2);
}

// ---- Tiny test framework ---------------------------------------------------
const levels = [];
function level(name, fn) {
  levels.push({ name, tests: [], fn });
}
let current;
function test(name, fn) {
  current.tests.push({ name, fn });
}
function assert(cond, message) {
  if (!cond) throw new Error(message || "assertion failed");
}
function eq(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message || "values differ"}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ---- HTTP helpers ----------------------------------------------------------
async function call(method, path, { body, key = API_KEY, headers = {}, raw } = {}) {
  const h = { ...headers };
  if (key !== null) h["X-API-Key"] = key;
  let payload;
  if (raw !== undefined) {
    payload = raw;
    h["Content-Type"] = "application/json";
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    h["Content-Type"] = "application/json";
  }
  const res = await fetch(BASE_URL + path, { method, headers: h, body: payload });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, text, headers: res.headers };
}
const get = (path, opts) => call("GET", path, opts);
const post = (path, body, opts = {}) => call("POST", path, { ...opts, body });
const del = (path, opts) => call("DELETE", path, opts);

// ---- Fixtures --------------------------------------------------------------
const RUN = Date.now().toString(36);
let emailCounter = 0;
const email = () => `e2e-${RUN}-${++emailCounter}@example.com`;

const at = (day, hour, minute = 0) => new Date(Date.UTC(2099, 11, day, hour, minute));
const iso = (d) => d.toISOString().replace(".000Z", "Z");
const mkSlot = (id, provider, start) => ({
  id,
  provider,
  start: iso(start),
  end: iso(new Date(start.getTime() + 30 * 60000)),
});

// 300 future slots named t1..t300, plus one slot that already started.
const STANDARD = [];
for (let i = 1; i <= 300; i++) {
  STANDARD.push(mkSlot(`t${i}`, i % 2 ? "Dr Ade" : "Dr Bello", at(1 + (i % 28), 8 + (i % 8), (i % 2) * 30)));
}
STANDARD.push(mkSlot("past1", "Dr Ade", new Date("2020-01-01T09:00:00Z")));

let slotCounter = 0;
const nextSlot = () => `t${++slotCounter}`; // each test takes a fresh, unbooked slot
const resetStandard = async () => {
  const r = await post("/reset", { slots: STANDARD });
  eq(r.status, 200, "reset status");
};
const book = (slot_id, extra = {}, opts = {}) =>
  post("/bookings", { slot_id, name: "Test Patient", email: email(), ...extra }, opts);
const slotById = async (id) => (await get("/slots")).json.slots.find((s) => s.id === id);

// ============================================================================
level("Level 1: list slots, book one, look up a booking", () => {
  test("POST /reset replaces slots and returns 200", async () => {
    const r = await post("/reset", { slots: STANDARD });
    eq(r.status, 200);
  });

  test("GET /slots returns { slots } with the documented fields, earliest start first", async () => {
    const odd = [
      mkSlot("late", "Dr Ade", at(20, 9)),
      mkSlot("early", "Dr Bello", at(2, 9)),
      mkSlot("middle", "Dr Ade", at(10, 9)),
    ];
    eq((await post("/reset", { slots: odd })).status, 200);
    const r = await get("/slots");
    eq(r.status, 200);
    eq(r.json.slots.map((s) => s.id), ["early", "middle", "late"], "order by start");
    const s = r.json.slots[0];
    eq(Object.keys(s).sort(), ["available", "end", "id", "provider", "start"], "slot fields");
    eq(s.start, iso(at(2, 9)), "start echoed as sent");
    eq(s.available, true);
    await resetStandard();
  });

  test("GET /slots?provider= filters by exact provider name", async () => {
    const all = (await get("/slots")).json.slots;
    const ade = (await get("/slots?provider=Dr%20Ade")).json.slots;
    assert(ade.length > 0 && ade.length < all.length, "filter should narrow the list");
    assert(ade.every((s) => s.provider === "Dr Ade"), "only Dr Ade");
    eq((await get("/slots?provider=dr%20ade")).json.slots.length, 0, "match is exact (case sensitive)");
    eq((await get("/slots?provider=Nobody")).json.slots, [], "unknown provider gives an empty list");
  });

  test("POST /bookings returns 201 with a confirmed booking", async () => {
    const slot = nextSlot();
    const r = await post("/bookings", { slot_id: slot, name: "Ada Obi", email: "ada.l1@example.com" });
    eq(r.status, 201);
    eq(Object.keys(r.json).sort(), ["created_at", "email", "id", "name", "slot_id", "status"], "booking fields");
    eq(r.json.status, "confirmed");
    eq(r.json.slot_id, slot);
    assert(typeof r.json.id === "string" && r.json.id.length > 0, "id is a string");
    assert(!Number.isNaN(Date.parse(r.json.created_at)), "created_at is a date-time");
  });

  test("a booked slot shows available: false", async () => {
    const slot = nextSlot();
    eq((await slotById(slot)).available, true, "before");
    eq((await book(slot)).status, 201);
    eq((await slotById(slot)).available, false, "after");
  });

  test("GET /bookings/{id} returns the booking; unknown id is 404 with { error }", async () => {
    const created = (await book(nextSlot())).json;
    const r = await get(`/bookings/${created.id}`);
    eq(r.status, 200);
    eq(r.json, created, "same booking");
    const missing = await get("/bookings/does-not-exist");
    eq(missing.status, 404);
    assert(typeof missing.json.error === "string", "error body");
  });

  test("POST /reset deletes existing bookings", async () => {
    const created = (await book(nextSlot())).json;
    await resetStandard();
    eq((await get(`/bookings/${created.id}`)).status, 404);
  });
});

// ============================================================================
level("Level 2: API key and validation", () => {
  test("every endpoint returns 401 with { error } when the key is missing", async () => {
    const calls = [
      get("/slots", { key: null }),
      post("/reset", { slots: [] }, { key: null }),
      post("/bookings", { slot_id: "t1", name: "A", email: "a@b.co" }, { key: null }),
      get("/bookings?email=a@b.co", { key: null }),
      get("/bookings/x", { key: null }),
      del("/bookings/x", { key: null }),
    ];
    for (const r of await Promise.all(calls)) {
      eq(r.status, 401);
      assert(typeof r.json.error === "string", "error body");
    }
  });

  test("a wrong key returns 401", async () => {
    eq((await get("/slots", { key: "definitely-wrong" })).status, 401);
    eq((await get("/slots", { key: "" })).status, 401);
  });

  test("the key is checked before the body (bad JSON without a key is still 401)", async () => {
    const r = await call("POST", "/bookings", { key: null, raw: "{not json" });
    eq(r.status, 401);
  });

  test("a failed unauthenticated reset leaves the data alone", async () => {
    const created = (await book(nextSlot())).json;
    eq((await post("/reset", { slots: [] }, { key: "wrong" })).status, 401);
    eq((await get(`/bookings/${created.id}`)).status, 200);
  });

  test("missing or empty slot_id, name, email -> 400 with { error }", async () => {
    const slot = nextSlot();
    // A fresh email per variant: one email may only try 5 times a minute (Level 5).
    const good = () => ({ slot_id: slot, name: "Ada", email: email() });
    const variants = [
      {},
      { ...good(), slot_id: undefined },
      { ...good(), name: undefined },
      { ...good(), email: undefined },
      { ...good(), slot_id: "" },
      { ...good(), name: "" },
      { ...good(), email: "" },
      { ...good(), name: "   " },
      { ...good(), email: "   " },
      { ...good(), name: 42 },
    ];
    for (const body of variants) {
      const r = await post("/bookings", body);
      eq(r.status, 400, `body ${JSON.stringify(body)}`);
      assert(typeof r.json.error === "string", "error body");
    }
    eq((await slotById(slot)).available, true, "nothing was booked");
  });

  test("invalid email addresses -> 400", async () => {
    for (const bad of ["plain", "no-at.example.com", "a@b", "a b@c.co", "@c.co", "a@"]) {
      eq((await post("/bookings", { slot_id: nextSlot(), name: "A", email: bad })).status, 400, bad);
    }
  });

  test("malformed JSON and non-object bodies -> 400", async () => {
    eq((await call("POST", "/bookings", { raw: "{not json" })).status, 400);
    eq((await call("POST", "/bookings", { raw: "[1,2]" })).status, 400);
    eq((await call("POST", "/bookings", { raw: "null" })).status, 400);
  });

  test("unknown slot -> 404 { error }", async () => {
    const r = await post("/bookings", { slot_id: "no-such-slot", name: "A", email: email() });
    eq(r.status, 404);
    assert(typeof r.json.error === "string", "error body");
  });

  test("a slot that has already started -> 400", async () => {
    const r = await post("/bookings", { slot_id: "past1", name: "A", email: email() });
    eq(r.status, 400);
    assert(typeof r.json.error === "string", "error body");
  });

  test("field errors come before slot errors (400 beats 404)", async () => {
    eq((await post("/bookings", { slot_id: "no-such-slot", name: "", email: email() })).status, 400);
  });

  test("name and email are trimmed; email is stored in lower case", async () => {
    const r = await post("/bookings", { slot_id: nextSlot(), name: "  Ada Obi  ", email: `  Mixed.CASE-${RUN}@Example.COM  ` });
    eq(r.status, 201);
    eq(r.json.name, "Ada Obi");
    eq(r.json.email, `mixed.case-${RUN}@example.com`);
  });
});

// ============================================================================
level("Level 3: no double booking, cancel", () => {
  test("a second booking for a taken slot -> 409 { error }", async () => {
    const slot = nextSlot();
    eq((await book(slot)).status, 201);
    const r = await book(slot);
    eq(r.status, 409);
    assert(typeof r.json.error === "string", "error body");
  });

  test("20 parallel bookings for one slot: exactly one 201, the rest 409", async () => {
    const slot = nextSlot();
    const results = await Promise.all(Array.from({ length: 20 }, () => book(slot)));
    const codes = results.map((r) => r.status);
    eq(codes.filter((c) => c === 201).length, 1, `201 count in ${codes}`);
    eq(codes.filter((c) => c === 409).length, 19, `409 count in ${codes}`);
    eq((await slotById(slot)).available, false);
  });

  test("DELETE cancels: 200, status cancelled, slot is free again", async () => {
    const slot = nextSlot();
    const created = (await book(slot)).json;
    const r = await del(`/bookings/${created.id}`);
    eq(r.status, 200);
    eq(r.json.status, "cancelled");
    eq(r.json.id, created.id);
    eq((await get(`/bookings/${created.id}`)).json.status, "cancelled", "GET shows cancelled");
    eq((await slotById(slot)).available, true);
  });

  test("cancelling twice -> 409; unknown id -> 404", async () => {
    const created = (await book(nextSlot())).json;
    eq((await del(`/bookings/${created.id}`)).status, 200);
    const again = await del(`/bookings/${created.id}`);
    eq(again.status, 409);
    assert(typeof again.json.error === "string", "error body");
    eq((await del("/bookings/does-not-exist")).status, 404);
  });

  test("cancel followed by rebook of the same slot works", async () => {
    const slot = nextSlot();
    const first = (await book(slot)).json;
    eq((await del(`/bookings/${first.id}`)).status, 200);
    const second = await book(slot);
    eq(second.status, 201);
    assert(second.json.id !== first.id, "a new booking, not the old one");
    eq((await slotById(slot)).available, false);
    eq((await book(slot)).status, 409, "and now it is taken again");
  });

  test("10 parallel cancels of one booking: exactly one 200, the rest 409", async () => {
    const created = (await book(nextSlot())).json;
    const codes = (await Promise.all(Array.from({ length: 10 }, () => del(`/bookings/${created.id}`)))).map((r) => r.status);
    eq(codes.filter((c) => c === 200).length, 1, `200 count in ${codes}`);
    eq(codes.filter((c) => c === 409).length, 9, `409 count in ${codes}`);
  });

  test("parallel cancel + rebook never leaves two confirmed bookings", async () => {
    const slot = nextSlot();
    const first = (await book(slot)).json;
    const mix = await Promise.all([del(`/bookings/${first.id}`), ...Array.from({ length: 8 }, () => book(slot))]);
    const created = mix.slice(1).filter((r) => r.status === 201).length;
    assert(created <= 1, `at most one new booking, got ${created}`);
  });
});

// ============================================================================
level("Level 4: idempotency and paging", () => {
  const idem = () => `key-${RUN}-${Math.random().toString(36).slice(2)}`;

  test("same Idempotency-Key + same body: same status and id, one booking", async () => {
    const slot = nextSlot();
    const body = { slot_id: slot, name: "Ada", email: email() };
    const key = idem();
    const first = await post("/bookings", body, { headers: { "Idempotency-Key": key } });
    eq(first.status, 201);
    for (let i = 0; i < 3; i++) {
      const again = await post("/bookings", body, { headers: { "Idempotency-Key": key } });
      eq(again.status, 201, "replay status");
      eq(again.json.id, first.json.id, "replay id");
      eq(again.json, first.json, "replay body");
    }
    const list = (await get(`/bookings?email=${encodeURIComponent(body.email)}`)).json.bookings;
    eq(list.length, 1, "exactly one booking exists");
  });

  test("5 parallel retries with one key: all return the same booking, one is created", async () => {
    const slot = nextSlot();
    const body = { slot_id: slot, name: "Ada", email: email() };
    const key = idem();
    const results = await Promise.all(Array.from({ length: 5 }, () => post("/bookings", body, { headers: { "Idempotency-Key": key } })));
    eq(results.map((r) => r.status), [201, 201, 201, 201, 201], "all 201");
    eq(new Set(results.map((r) => r.json.id)).size, 1, "one booking id");
    const list = (await get(`/bookings?email=${encodeURIComponent(body.email)}`)).json.bookings;
    eq(list.length, 1, "exactly one booking exists");
  });

  test("same key + different body -> 422 { error }", async () => {
    const key = idem();
    const addr = email();
    const first = await post("/bookings", { slot_id: nextSlot(), name: "Ada", email: addr }, { headers: { "Idempotency-Key": key } });
    eq(first.status, 201);
    const other = await post("/bookings", { slot_id: nextSlot(), name: "Ada", email: addr }, { headers: { "Idempotency-Key": key } });
    eq(other.status, 422);
    assert(typeof other.json.error === "string", "error body");
  });

  test("a validation failure does not use up the key", async () => {
    const key = idem();
    const slot = nextSlot();
    const bad = await post("/bookings", { slot_id: slot, name: "", email: email() }, { headers: { "Idempotency-Key": key } });
    eq(bad.status, 400);
    const good = await post("/bookings", { slot_id: slot, name: "Ada", email: email() }, { headers: { "Idempotency-Key": key } });
    eq(good.status, 201, "the same key still works for a valid request");
  });

  test("a 409 does not use up the key either", async () => {
    const slot = nextSlot();
    const holder = (await book(slot)).json;
    const key = idem();
    const body = { slot_id: slot, name: "Ben", email: email() };
    eq((await post("/bookings", body, { headers: { "Idempotency-Key": key } })).status, 409);
    eq((await del(`/bookings/${holder.id}`)).status, 200);
    eq((await post("/bookings", body, { headers: { "Idempotency-Key": key } })).status, 201, "works once the slot is free");
  });

  test("without a key, an identical retry is just a normal request (409)", async () => {
    const slot = nextSlot();
    const body = { slot_id: slot, name: "Ada", email: email() };
    eq((await post("/bookings", body)).status, 201);
    eq((await post("/bookings", body)).status, 409);
  });

  test("GET /bookings pages oldest first and ends with next_cursor: null", async () => {
    const addr = email();
    const made = [];
    for (let i = 0; i < 5; i++) {
      const r = await post("/bookings", { slot_id: nextSlot(), name: `P${i}`, email: addr });
      eq(r.status, 201);
      made.push(r.json);
    }
    eq((await del(`/bookings/${made[1].id}`)).status, 200); // cancelled bookings stay in the list

    const seen = [];
    let cursor = null;
    let pages = 0;
    do {
      const r = await get(`/bookings?email=${encodeURIComponent(addr.toUpperCase())}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      eq(r.status, 200);
      assert(Array.isArray(r.json.bookings), "bookings is an array");
      assert("next_cursor" in r.json, "next_cursor is present");
      seen.push(...r.json.bookings);
      cursor = r.json.next_cursor;
      pages++;
      assert(pages <= 5, "paging must terminate");
    } while (cursor !== null);

    eq(pages, 3, "5 bookings at 2 per page = 3 pages");
    eq(seen.map((b) => b.id), made.map((b) => b.id), "all bookings, oldest first, no repeats");
    eq(seen[1].status, "cancelled", "cancelled booking is included with its status");
  });

  test("paging edge cases: exact fit, default limit, other people, empty list", async () => {
    const addr = email();
    for (let i = 0; i < 3; i++) eq((await post("/bookings", { slot_id: nextSlot(), name: "P", email: addr })).status, 201);
    const exact = await get(`/bookings?email=${encodeURIComponent(addr)}&limit=3`);
    eq(exact.json.bookings.length, 3);
    eq(exact.json.next_cursor, null, "last page is null even when it is exactly full");
    eq((await get(`/bookings?email=${encodeURIComponent(addr)}`)).json.bookings.length, 3, "default limit is 10");
    const none = await get(`/bookings?email=${encodeURIComponent(email())}`);
    eq(none.status, 200);
    eq(none.json, { bookings: [], next_cursor: null }, "someone with no bookings");
  });

  test("invalid limit, cursor or email -> 400", async () => {
    const addr = encodeURIComponent(email());
    for (const q of [`email=${addr}&limit=0`, `email=${addr}&limit=51`, `email=${addr}&limit=-1`, `email=${addr}&limit=abc`, `email=${addr}&limit=2.5`, `email=${addr}&cursor=garbage`, "email=not-an-email", ""]) {
      const r = await get(`/bookings?${q}`);
      eq(r.status, 400, q);
      assert(typeof r.json.error === "string", "error body");
    }
    eq((await get(`/bookings?email=${addr}&limit=50`)).status, 200, "limit 50 is allowed");
    eq((await get(`/bookings?email=${addr}&limit=1`)).status, 200, "limit 1 is allowed");
  });
});

// ============================================================================
level("Level 5: rate limit", () => {
  test("the 6th attempt for an email in a minute -> 429 with Retry-After", async () => {
    const addr = email();
    const slot = nextSlot();
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await post("/bookings", { slot_id: slot, name: "Spam", email: addr })).status);
    eq(codes, [201, 409, 409, 409, 409], "failed attempts (409) count too, but are not blocked");
    const sixth = await post("/bookings", { slot_id: slot, name: "Spam", email: addr });
    eq(sixth.status, 429);
    assert(typeof sixth.json.error === "string", "error body");
    const retry = sixth.headers.get("retry-after");
    assert(/^\d+$/.test(retry || ""), `Retry-After is whole seconds, got ${retry}`);
    assert(Number(retry) >= 1 && Number(retry) <= 60, `Retry-After within 1..60, got ${retry}`);
  });

  test("failed attempts (validation errors) count toward the limit", async () => {
    const addr = email();
    for (let i = 0; i < 5; i++) eq((await post("/bookings", { slot_id: nextSlot(), name: "", email: addr })).status, 400);
    eq((await post("/bookings", { slot_id: nextSlot(), name: "Ada", email: addr })).status, 429);
  });

  test("other emails are not affected", async () => {
    const spammer = email();
    for (let i = 0; i < 6; i++) await post("/bookings", { slot_id: nextSlot(), name: "", email: spammer });
    eq((await book(nextSlot())).status, 201);
  });

  test("the same email in different case or with spaces shares one limit", async () => {
    const addr = email();
    const variants = [addr, addr.toUpperCase(), ` ${addr} `, addr, addr.toUpperCase()];
    for (const v of variants) eq((await post("/bookings", { slot_id: nextSlot(), name: "", email: v })).status, 400);
    eq((await post("/bookings", { slot_id: nextSlot(), name: "Ada", email: addr })).status, 429);
  });

  test("12 parallel attempts for one email: exactly 5 get through, 7 get 429", async () => {
    const addr = email();
    const slot = nextSlot();
    const codes = (await Promise.all(Array.from({ length: 12 }, () => post("/bookings", { slot_id: slot, name: "Par", email: addr })))).map((r) => r.status);
    eq(codes.filter((c) => c === 429).length, 7, `429 count in ${codes}`);
    eq(codes.filter((c) => c === 201).length, 1, `201 count in ${codes}`);
    eq(codes.filter((c) => c === 409).length, 4, `409 count in ${codes}`);
  });

  test("unauthenticated requests and unusable emails do not use up the limit", async () => {
    const addr = email();
    for (let i = 0; i < 6; i++) {
      eq((await post("/bookings", { slot_id: nextSlot(), name: "A", email: addr }, { key: "wrong" })).status, 401);
    }
    for (let i = 0; i < 6; i++) eq((await post("/bookings", { slot_id: nextSlot(), name: "A", email: "not-an-email" })).status, 400);
    eq((await post("/bookings", { slot_id: nextSlot(), name: "A", email: addr })).status, 201);
  });

  test("POST /reset clears rate-limit state", async () => {
    const addr = email();
    for (let i = 0; i < 5; i++) await post("/bookings", { slot_id: nextSlot(), name: "", email: addr });
    eq((await post("/bookings", { slot_id: nextSlot(), name: "Ada", email: addr })).status, 429, "limited before reset");
    await resetStandard();
    eq((await post("/bookings", { slot_id: nextSlot(), name: "Ada", email: addr })).status, 201, "free after reset");
  });

  test("POST /reset clears idempotency state", async () => {
    const key = `reset-${RUN}`;
    const addr = email();
    const slot = nextSlot();
    const first = await post("/bookings", { slot_id: slot, name: "Ada", email: addr }, { headers: { "Idempotency-Key": key } });
    eq(first.status, 201);
    await resetStandard();
    // Same key, different body: would be 422 if the old key survived the reset.
    const differentBody = await post("/bookings", { slot_id: nextSlot(), name: "Someone Else", email: addr }, { headers: { "Idempotency-Key": key } });
    eq(differentBody.status, 201, "old key forgotten (no 422)");
    // Same key, same body as the very first request: must be a fresh booking, not a replay.
    await resetStandard();
    const again = await post("/bookings", { slot_id: slot, name: "Ada", email: addr }, { headers: { "Idempotency-Key": key } });
    eq(again.status, 201);
    assert(again.json.id !== first.json.id, "a new booking, not a replay of the pre-reset one");
  });
});

// ============================================================================
level("Web page", () => {
  test("GET / serves the page and it never contains the API key", async () => {
    const r = await call("GET", "/", { key: null });
    eq(r.status, 200);
    assert(r.text.includes("<html"), "is HTML");
    assert(!r.text.includes(API_KEY), "the API key must not appear in the page");
  });

  test("the page's own routes work without a key: list, book, look up, cancel", async () => {
    const slot = nextSlot();
    const slots = await get("/web/slots", { key: null });
    eq(slots.status, 200);
    const made = await post("/web/bookings", { slot_id: slot, name: "Web User", email: email() }, { key: null, headers: { "Idempotency-Key": `web-${RUN}-${slot}` } });
    eq(made.status, 201);
    eq((await get(`/web/bookings/${made.json.id}`, { key: null })).json.id, made.json.id);
    const cancelled = await del(`/web/bookings/${made.json.id}`, { key: null });
    eq(cancelled.json.status, "cancelled");
  });

  test("/reset and the by-email list are NOT reachable from the page's routes", async () => {
    eq((await post("/web/reset", { slots: [] }, { key: null })).status, 404);
    eq((await get("/web/bookings?email=a@b.co", { key: null })).status, 404);
    const stillThere = await get("/slots");
    assert(stillThere.json.slots.length > 0, "slots are intact");
  });

  test("the real API still needs the key", async () => {
    eq((await get("/slots", { key: null })).status, 401);
  });
});

// ============================================================================
async function main() {
  console.log(`Testing ${BASE_URL}\n`);
  try {
    await resetStandard();
  } catch (err) {
    console.error(`Cannot reach the API or reset failed: ${err.message}`);
    process.exit(2);
  }

  const summary = [];
  for (const lvl of levels) {
    current = lvl;
    lvl.fn(); // registers the tests
    console.log(lvl.name);
    let passed = 0;
    for (const t of lvl.tests) {
      try {
        await t.fn();
        passed++;
        console.log(`  PASS  ${t.name}`);
      } catch (err) {
        console.log(`  FAIL  ${t.name}\n        ${err.message}`);
      }
    }
    summary.push({ name: lvl.name, passed, total: lvl.tests.length });
    console.log();
    await resetStandard(); // each level starts from a clean slate
    slotCounter = 0;
  }

  console.log("Summary");
  let failed = 0;
  for (const s of summary) {
    const ok = s.passed === s.total;
    if (!ok) failed++;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${s.name} (${s.passed}/${s.total})`);
  }
  process.exit(failed ? 1 : 0);
}

main();

// Contract check: calls the API and validates every documented response against
// SPEC.json (status code, headers and JSON body), using ajv.
//
//   BASE_URL=http://localhost:3000 API_KEY=yourkey npm run test:contract
//
// WARNING: this calls POST /reset, which deletes every booking and replaces
// every slot in the database the server is connected to.
//
// It only reports. It never changes the API. Exit code 1 if anything differs.

const Ajv = require("ajv");
const addFormats = require("ajv-formats");
const spec = require("../SPEC.json");

const BASE_URL = (process.env.BASE_URL || "").replace(/\/+$/, "");
const API_KEY = process.env.API_KEY;
if (!BASE_URL || !API_KEY) {
  console.error("Set BASE_URL and API_KEY, for example:\n  BASE_URL=http://localhost:3000 API_KEY=secret npm run test:contract");
  process.exit(2);
}

// ---- Ajv set up with the spec's components ---------------------------------
const SPEC_ID = "https://contract.local/spec.json";
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ $id: SPEC_ID, components: spec.components });

// Point "#/components/..." references at the spec document registered above.
function withRefs(node) {
  if (Array.isArray(node)) return node.map(withRefs);
  if (node && typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      out[k] = k === "$ref" && typeof v === "string" && v.startsWith("#/") ? SPEC_ID + v : withRefs(v);
    }
    return out;
  }
  return node;
}
const validators = new Map();
function validatorFor(schema) {
  const key = JSON.stringify(schema);
  if (!validators.has(key)) validators.set(key, ajv.compile(withRefs(schema)));
  return validators.get(key);
}

const ERROR_SCHEMA = { $ref: "#/components/schemas/Error" };

// ---- Results ---------------------------------------------------------------
const mismatches = [];
const notes = [];
const lines = [];
let checks = 0;

const short = (v) => {
  const s = typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v);
  const text = s === undefined ? "undefined" : s;
  return text.length > 140 ? text.slice(0, 137) + "..." : text;
};
const pointer = (obj, ptr) => ptr.split("/").slice(1).reduce((o, k) => (o == null ? undefined : o[k.replace(/~1/g, "/").replace(/~0/g, "~")]), obj);

// ---- HTTP ------------------------------------------------------------------
async function call(method, path, { body, key = API_KEY, headers = {}, raw } = {}) {
  const h = { ...headers };
  if (key !== null) h["X-API-Key"] = key;
  let payload;
  if (raw !== undefined) payload = raw;
  else if (body !== undefined) payload = JSON.stringify(body);
  if (payload !== undefined) h["Content-Type"] = "application/json";
  const res = await fetch(BASE_URL + path, { method, headers: h, body: payload });
  const text = await res.text();
  let json;
  let jsonOk = true;
  try {
    json = text === "" ? undefined : JSON.parse(text);
  } catch {
    jsonOk = false;
  }
  return { status: res.status, headers: res.headers, text, json, jsonOk };
}
const get = (p, o) => call("GET", p, o);
const post = (p, body, o = {}) => call("POST", p, { ...o, body });
const del = (p, o) => call("DELETE", p, o);

// ---- The core check --------------------------------------------------------
// Compares one real response with what SPEC.json documents for it.
//   template: the spec path, e.g. "/bookings/{id}"
//   method:   "GET" | "POST" | "DELETE"
//   expected: the documented status code this scenario is meant to trigger
function check(template, method, expected, label, res) {
  checks++;
  const where = `${method} ${template} -> ${expected} (${label})`;
  const found = [];
  const bad = (field, exp, act) => found.push({ where, field, expected: exp, actual: act });

  const op = spec.paths[template][method.toLowerCase()];
  // 401 is documented once for the whole API (info.description + securitySchemes).
  const documented = expected === 401 ? { content: { "application/json": { schema: ERROR_SCHEMA } } } : op.responses[String(expected)];
  if (!documented) {
    bad("status", `a documented response for ${expected} in paths.${template}.${method.toLowerCase()}.responses`, "none (the scenario itself is wrong)");
  } else {
    // 1. Status
    if (res.status !== expected) bad("status", expected, `${res.status} ${short(res.json ?? res.text)}`);
    const actualDocumented = res.status === 401 || op.responses[String(res.status)];
    if (!actualDocumented) bad("status", `one of ${Object.keys(op.responses).join(", ")} (or 401)`, `${res.status} (not documented for this operation)`);

    // 2. Body against the schema documented for the status we actually got
    const docForActual = res.status === 401 ? documented : op.responses[String(res.status)] || documented;
    const schema = docForActual.content && docForActual.content["application/json"] && docForActual.content["application/json"].schema;
    if (schema) {
      const ctype = res.headers.get("content-type") || "";
      if (!/application\/json/i.test(ctype)) bad("header Content-Type", "application/json", ctype || "(missing)");
      if (!res.jsonOk || res.json === undefined) {
        bad("body", "valid JSON", short(res.text));
      } else {
        const validate = validatorFor(schema);
        if (!validate(res.json)) {
          for (const e of validate.errors) {
            const field = "body" + e.instancePath.replace(/\//g, ".") + (e.keyword === "required" ? "." + e.params.missingProperty : "");
            const value = e.keyword === "required" ? "(missing)" : short(pointer(res.json, e.instancePath));
            bad(field, `${e.keyword} ${short(e.params)}: ${e.message}`, value);
          }
        }
      }
    } else if (res.text !== "") {
      notes.push(`${where}: the spec documents no body for this response, but the API returned ${short(res.json ?? res.text)}`);
    }

    // 3. Headers documented for the status we actually got
    for (const [name, def] of Object.entries(docForActual.headers || {})) {
      const value = res.headers.get(name);
      if (value === null) {
        bad(`header ${name}`, `present (${def.description || "documented header"})`, "(missing)");
        continue;
      }
      const typed = def.schema.type === "integer" || def.schema.type === "number" ? (/^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value) : value;
      const validate = validatorFor(def.schema);
      if (!validate(typed)) bad(`header ${name}`, `${def.schema.type}`, short(value));
    }
  }

  lines.push(`  ${found.length ? "FAIL" : "PASS"}  ${expected}  ${label}`);
  mismatches.push(...found);
  return res;
}

// A described behaviour that is not a schema rule (ordering, trimming, ...).
function behaviour(where, field, ok, expected, actual) {
  checks++;
  lines.push(`  ${ok ? "PASS" : "FAIL"}  --   ${field}`);
  if (!ok) mismatches.push({ where, field, expected, actual: short(actual) });
}

function section(title) {
  lines.push("", title);
}

// ---- Fixtures --------------------------------------------------------------
const RUN = Date.now().toString(36);
let n = 0;
const email = () => `contract-${RUN}-${++n}@example.com`;
const day = (d, h, m = 0) => new Date(Date.UTC(2099, 11, d, h, m));
const iso = (d) => d.toISOString().replace(".000Z", "Z");
const slot = (id, provider, d) => ({ id, provider, start: iso(d), end: iso(new Date(d.getTime() + 30 * 60000)) });
const SLOTS = [];
for (let i = 1; i <= 60; i++) SLOTS.push(slot(`c${i}`, i % 2 ? "Dr Ade" : "Dr Bello", day(1 + (i % 25), 8 + (i % 8), (i % 2) * 30)));
SLOTS.push(slot("cpast", "Dr Ade", new Date("2020-01-01T09:00:00Z")));
let s = 0;
const freshSlot = () => `c${++s}`;
const newBooking = (extra = {}, opts) => post("/bookings", { slot_id: freshSlot(), name: "Contract Test", email: email(), ...extra }, opts);

// ---- Scenarios -------------------------------------------------------------
async function run() {
  // POST /reset ---------------------------------------------------------------
  section("POST /reset");
  const reset = check("/reset", "POST", 200, "replace all slots", await post("/reset", { slots: SLOTS }));
  check("/reset", "POST", 401, "no X-API-Key", await post("/reset", { slots: SLOTS }, { key: null }));
  check("/reset", "POST", 401, "wrong X-API-Key", await post("/reset", { slots: SLOTS }, { key: "wrong-key" }));
  const stillThere = await get("/slots");
  behaviour("POST /reset", "an unauthenticated /reset must not delete anything", stillThere.json && stillThere.json.slots.length === SLOTS.length, `${SLOTS.length} slots`, stillThere.json && stillThere.json.slots.length);

  // GET /slots ----------------------------------------------------------------
  section("GET /slots");
  const slots = check("/slots", "GET", 200, "list all slots", await get("/slots"));
  check("/slots", "GET", 200, "filter by provider", await get("/slots?provider=Dr%20Ade"));
  check("/slots", "GET", 401, "no X-API-Key", await get("/slots", { key: null }));
  check("/slots", "GET", 401, "wrong X-API-Key", await get("/slots", { key: "wrong-key" }));
  if (slots.json && Array.isArray(slots.json.slots)) {
    const starts = slots.json.slots.map((x) => Date.parse(x.start));
    behaviour("GET /slots", "\"Every slot, earliest start first\"", starts.every((t, i) => i === 0 || starts[i - 1] <= t), "start ascending", starts.slice(0, 5));
    const ade = (await get("/slots?provider=Dr%20Ade")).json.slots;
    behaviour("GET /slots?provider=", "\"Only this provider's slots (exact match)\"", ade.length > 0 && ade.every((x) => x.provider === "Dr Ade"), "only Dr Ade", ade.map((x) => x.provider).slice(0, 3));
    behaviour("GET /slots?provider=", "exact match: lower-case name matches nothing", (await get("/slots?provider=dr%20ade")).json.slots.length === 0, "[]", "non-empty");
  }

  // POST /bookings -------------------------------------------------------------
  section("POST /bookings");
  const bookedSlot = freshSlot();
  const made = check("/bookings", "POST", 201, "valid booking", await post("/bookings", { slot_id: bookedSlot, name: "Ada Obi", email: email() }));
  const trimmed = check("/bookings", "POST", 201, "name and email with spaces and capitals", await post("/bookings", { slot_id: freshSlot(), name: "  Ada Obi  ", email: `  MiXeD-${RUN}@Example.COM  ` }));
  if (trimmed.json) {
    behaviour("POST /bookings", "\"Trim spaces from name\"", trimmed.json.name === "Ada Obi", "\"Ada Obi\"", trimmed.json.name);
    behaviour("POST /bookings", "\"store email in lower case\" (and trimmed)", trimmed.json.email === `mixed-${RUN}@example.com`, `mixed-${RUN}@example.com`, trimmed.json.email);
  }
  const slotAfter = (await get("/slots")).json.slots.find((x) => x.id === bookedSlot);
  behaviour("GET /slots", "available is \"false while the slot has a confirmed booking\"", slotAfter && slotAfter.available === false, false, slotAfter && slotAfter.available);

  check("/bookings", "POST", 400, "slot_id missing", await post("/bookings", { name: "A", email: email() }));
  check("/bookings", "POST", 400, "name empty", await post("/bookings", { slot_id: freshSlot(), name: "", email: email() }));
  check("/bookings", "POST", 400, "name only spaces", await post("/bookings", { slot_id: freshSlot(), name: "   ", email: email() }));
  check("/bookings", "POST", 400, "email missing", await post("/bookings", { slot_id: freshSlot(), name: "A" }));
  check("/bookings", "POST", 400, "email not valid", await post("/bookings", { slot_id: freshSlot(), name: "A", email: "not-an-email" }));
  check("/bookings", "POST", 400, "slot has already started", await post("/bookings", { slot_id: "cpast", name: "A", email: email() }));
  check("/bookings", "POST", 404, "slot does not exist", await post("/bookings", { slot_id: "no-such-slot", name: "A", email: email() }));
  check("/bookings", "POST", 409, "slot already booked", await post("/bookings", { slot_id: bookedSlot, name: "Other", email: email() }));

  const key = `contract-${RUN}`;
  const idemSlot = freshSlot();
  const idemEmail = email();
  const first = check("/bookings", "POST", 201, "Idempotency-Key, first request", await post("/bookings", { slot_id: idemSlot, name: "Ada", email: idemEmail }, { headers: { "Idempotency-Key": key } }));
  const replay = check("/bookings", "POST", 201, "Idempotency-Key, same body replayed", await post("/bookings", { slot_id: idemSlot, name: "Ada", email: idemEmail }, { headers: { "Idempotency-Key": key } }));
  if (first.json && replay.json) {
    behaviour("POST /bookings", "replay returns \"same booking id\"", first.json.id === replay.json.id, first.json.id, replay.json.id);
    behaviour("POST /bookings", "replay returns the same response body", JSON.stringify(first.json) === JSON.stringify(replay.json), first.text, replay.text);
  }
  check("/bookings", "POST", 422, "Idempotency-Key reused with a different body", await post("/bookings", { slot_id: freshSlot(), name: "Ada", email: idemEmail }, { headers: { "Idempotency-Key": key } }));

  // 429: five attempts allowed (failed ones included), the 6th is rejected.
  const spam = email();
  const spamSlot = freshSlot();
  for (let i = 0; i < 5; i++) {
    const r = await post("/bookings", { slot_id: spamSlot, name: "Spam", email: spam });
    behaviour("POST /bookings", `attempt ${i + 1} of 5 for one email is not rate limited`, r.status !== 429, "not 429", r.status);
  }
  const limited = check("/bookings", "POST", 429, "6th attempt for the same email", await post("/bookings", { slot_id: spamSlot, name: "Spam", email: spam }));
  const retry = limited.headers.get("retry-after");
  behaviour("POST /bookings -> 429", "Retry-After is \"whole seconds\" (an integer, not a date or a decimal)", retry !== null && /^\d+$/.test(retry), "digits only, e.g. 42", retry);
  behaviour("POST /bookings -> 429", "\"Other emails aren't affected\"", (await newBooking()).status === 201, 201, "not 201");

  check("/bookings", "POST", 401, "no X-API-Key", await post("/bookings", { slot_id: freshSlot(), name: "A", email: email() }, { key: null }));
  check("/bookings", "POST", 401, "wrong X-API-Key", await post("/bookings", { slot_id: freshSlot(), name: "A", email: email() }, { key: "wrong-key" }));

  // GET /bookings --------------------------------------------------------------
  section("GET /bookings");
  const person = email();
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const r = await post("/bookings", { slot_id: freshSlot(), name: `P${i}`, email: person });
    if (r.json) ids.push(r.json.id);
  }
  const q = (extra) => `/bookings?email=${encodeURIComponent(person)}${extra}`;
  const page1 = check("/bookings", "GET", 200, "first page, limit=2 (next_cursor is a string)", await get(q("&limit=2")));
  if (page1.json) {
    behaviour("GET /bookings", "first page of 3 with limit=2 has a string next_cursor", typeof page1.json.next_cursor === "string", "string", page1.json.next_cursor);
    const page2 = check("/bookings", "GET", 200, "last page via cursor (next_cursor is null)", await get(q(`&limit=2&cursor=${encodeURIComponent(page1.json.next_cursor)}`)));
    if (page2.json) {
      behaviour("GET /bookings", "\"The last page has next_cursor: null\"", page2.json.next_cursor === null, null, page2.json.next_cursor);
      const all = [...page1.json.bookings, ...page2.json.bookings].map((b) => b.id);
      behaviour("GET /bookings", "\"oldest first\", every booking exactly once", JSON.stringify(all) === JSON.stringify(ids), ids, all);
    }
  }
  check("/bookings", "GET", 200, "no limit (default)", await get(q("")));
  check("/bookings", "GET", 200, "limit=1 (minimum)", await get(q("&limit=1")));
  check("/bookings", "GET", 200, "limit=50 (maximum)", await get(q("&limit=50")));
  check("/bookings", "GET", 200, "email in a different case", await get(`/bookings?email=${encodeURIComponent(person.toUpperCase())}`));
  const nobody = check("/bookings", "GET", 200, "person with no bookings", await get(`/bookings?email=${encodeURIComponent(email())}`));
  if (nobody.json) behaviour("GET /bookings", "no bookings gives an empty page with next_cursor null", nobody.json.bookings.length === 0 && nobody.json.next_cursor === null, "[] and null", nobody.json);
  check("/bookings", "GET", 400, "limit=0", await get(q("&limit=0")));
  check("/bookings", "GET", 400, "limit=51", await get(q("&limit=51")));
  check("/bookings", "GET", 400, "limit=abc", await get(q("&limit=abc")));
  check("/bookings", "GET", 400, "limit=-1", await get(q("&limit=-1")));
  check("/bookings", "GET", 401, "no X-API-Key", await get(q(""), { key: null }));
  check("/bookings", "GET", 401, "wrong X-API-Key", await get(q(""), { key: "wrong-key" }));

  // GET /bookings/{id} -----------------------------------------------------------
  section("GET /bookings/{id}");
  const target = await newBooking();
  const got = check("/bookings/{id}", "GET", 200, "existing booking", await get(`/bookings/${target.json.id}`));
  if (got.json) behaviour("GET /bookings/{id}", "returns the same booking that was created", JSON.stringify(got.json) === JSON.stringify(target.json), target.text, got.text);
  check("/bookings/{id}", "GET", 404, "unknown id", await get("/bookings/does-not-exist"));
  check("/bookings/{id}", "GET", 401, "no X-API-Key", await get(`/bookings/${target.json.id}`, { key: null }));
  check("/bookings/{id}", "GET", 401, "wrong X-API-Key", await get(`/bookings/${target.json.id}`, { key: "wrong-key" }));

  // DELETE /bookings/{id} ---------------------------------------------------------
  section("DELETE /bookings/{id}");
  const victim = await newBooking();
  const cancelled = check("/bookings/{id}", "DELETE", 200, "cancel a booking", await del(`/bookings/${victim.json.id}`));
  if (cancelled.json) {
    behaviour("DELETE /bookings/{id}", "\"Sets status to cancelled\"", cancelled.json.status === "cancelled", "cancelled", cancelled.json.status);
    const freed = (await get("/slots")).json.slots.find((x) => x.id === victim.json.slot_id);
    behaviour("DELETE /bookings/{id}", "\"frees the slot\"", freed && freed.available === true, true, freed && freed.available);
  }
  check("/bookings/{id}", "DELETE", 409, "already cancelled", await del(`/bookings/${victim.json.id}`));
  check("/bookings/{id}", "DELETE", 404, "unknown id", await del("/bookings/does-not-exist"));
  check("/bookings/{id}", "DELETE", 401, "no X-API-Key", await del(`/bookings/${victim.json.id}`, { key: null }));
  check("/bookings/{id}", "DELETE", 401, "wrong X-API-Key", await del(`/bookings/${victim.json.id}`, { key: "wrong-key" }));

  // Things the spec is silent about: reported as notes, never as mismatches.
  section("Probes where the spec is silent (notes only)");
  const probe = async (what, res) => {
    lines.push(`  NOTE  ${res.status}  ${what}`);
    notes.push(`${what}: the API returned ${res.status} ${short(res.json ?? res.text)}`);
  };
  await probe("POST /reset with { } (no slots array); spec documents only 200", await post("/reset", {}));
  await probe("GET /bookings with no email; spec marks email required but documents 400 only as \"Invalid limit\"", await get("/bookings"));
  await probe("GET /bookings with an unknown cursor; spec documents no cursor errors", await get(q("&cursor=garbage")));
  await probe("POST /bookings with malformed JSON; spec documents no such case", await call("POST", "/bookings", { raw: "{not json" }));
  const unknown = await get("/nothing-here");
  await probe("GET on a path that is not in the spec", unknown);
}

async function main() {
  console.log(`Contract check against ${BASE_URL}\nSpec: SPEC.json (${spec.info.title} v${spec.info.version}, OpenAPI ${spec.openapi})`);
  try {
    await run();
  } catch (err) {
    console.error(`\nThe check could not finish: ${err.message}`);
    process.exit(2);
  }
  console.log(lines.join("\n"));
  console.log(`\n${checks} checks, ${mismatches.length} mismatch${mismatches.length === 1 ? "" : "es"}, ${notes.length} note${notes.length === 1 ? "" : "s"}`);
  if (mismatches.length) {
    console.log("\nMISMATCHES");
    mismatches.forEach((m, i) => console.log(`\n${i + 1}. ${m.where}\n   field:    ${m.field}\n   expected: ${typeof m.expected === "string" ? m.expected : short(m.expected)}\n   actual:   ${typeof m.actual === "string" ? m.actual : short(m.actual)}`));
  }
  if (notes.length) {
    console.log("\nNOTES (spec silent or documents no body; not counted as mismatches)");
    notes.forEach((x, i) => console.log(`  ${i + 1}. ${x}`));
  }
  process.exit(mismatches.length ? 1 : 0);
}

main();

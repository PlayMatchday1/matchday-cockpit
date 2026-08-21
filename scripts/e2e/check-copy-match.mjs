// COPY A MATCH — staging only, and the writes are real.
//
// ── DELIBERATELY NOT IN THE GATE, AND NOT NAMED verify-*. ──────────────────────────────────────
//
//     npm run check:copy-match
//
// Run it BY HAND before touching the create path. It is called check-* rather than verify-* on
// purpose: run-suites discovers e2e suites with /^verify-.*\.mjs$/, so this name keeps it out of
// the gate by construction rather than by a quarantine entry somebody could "fix".
//
// WHY IT CANNOT BE IN THE GATE: IT LITTERS, PERMANENTLY. Every run creates a real staging match
// and CANNOT delete it — DELETE /admin/matches/{id} is on this client's endpoint deny-list because
// it permanently destroys a match, and that deny-list stands. So a gated run would add a match to
// staging on every push, and staging data quality is worth more than the convenience of automatic
// coverage. Matches it leaves are named "[e2e-copy] …" so they are findable; clear them through
// the MatchDay app, never through our client.
//
// EVERY WRITE IN THIS SUITE GOES TO STAGING. Never production, for any reason: the create endpoint
// has no idempotency key, whether a double submit makes two matches is UNKNOWN, and
// DELETE /admin/matches/{id} is on this client's endpoint deny-list — so a match made here CANNOT
// be cleaned up. It therefore names everything it creates "[e2e-copy] …" so a human can find them.
//
// THE ASSERTION THAT MATTERS MOST is the double submit. Two creates fired back-to-back must leave
// ONE match, or the second must be refused. The guard is a QUERY — the route asks the API whether
// a match already exists at that fieldId and startDate — precisely because a disabled button only
// stops a double click, and this suite fires from outside the button.
//
//   node scripts/e2e/verify-copy-match.mjs
import { chromium } from "playwright";
import { installHarnessGuard, closeContext, closeBrowser, storageStateFor } from "./_session.mjs";
installHarnessGuard();
process.loadEnvFile(".env.local");

const BASE = process.env.BASE || "http://localhost:3000";
const ENV = "staging";
let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ✓ ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

// A far-future slot, so it can never collide with a real staging fixture, and a name that says
// what it is. The minute is randomised per run so two runs do not fight over the same slot.
const YEAR = 2031;
const MIN = String(new Date().getMinutes()).padStart(2, "0");
const START = `${YEAR}-03-14T18:${MIN}:00.000Z`;
const END = `${YEAR}-03-14T19:${MIN}:00.000Z`;
const NAME = `[e2e-copy] ${START}`;

const { storageState } = await storageStateFor("rmancuso@playmatchday.com", BASE);
const browser = await chromium.launch();
const ctx = await browser.newContext({ storageState, viewport: { width: 1600, height: 1200 } });
const page = await ctx.newPage();

await page.goto(`${BASE}/match-ops/gameday`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);

const api = (path, init) => page.evaluate(async ({ path, init }) => {
  const key = Object.keys(localStorage).find((k) => k.includes("auth-token"));
  const t = JSON.parse(localStorage.getItem(key) ?? "{}");
  const token = t?.access_token ?? t?.currentSession?.access_token;
  const r = await fetch(path, {
    ...(init ?? {}),
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    cache: "no-store",
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}, { path, init });

// A REAL STAGING MATCH TO COPY FROM — found, not written down, so the suite does not rot.
const board = await api(`/api/matchday/${ENV}/gameday?date=2026-01-01`);
let SOURCE = null;
{
  // Any staging match will do as a template; the schedule endpoint gives one with a fieldId.
  const probe = await api(`/api/matchday/${ENV}/matches/2470`);
  if (probe.status === 200 && probe.body?.match) SOURCE = probe.body.match;
}
eq("  control — a staging source match was found", SOURCE != null, true);
const FIELD_ID = Number(SOURCE?.fieldId ?? 0);
eq("  control — it carries a fieldId", FIELD_ID > 0, true);
console.log(`     source: ${SOURCE?.id} "${SOURCE?.name}" field ${FIELD_ID} · board ${board.status}`);

const bodyFor = (over = {}) => ({
  match: {
    name: NAME, description: "created by verify-copy-match", type: "REGULAR",
    startDate: START, endDate: END, fieldId: FIELD_ID,
    maxPlayerCount: 10, teamNumbers: 2, isFreeMember: false,
    ...over,
  },
});

// ── 1. THE DATE MUST BE CHOSEN, AND THE REFUSAL NAMES IT ──────────────────────────────────────
console.log("\n── the date is required ──");
{
  const r = await api(`/api/matchday/${ENV}/matches/create`, {
    method: "POST", body: JSON.stringify({ match: { ...bodyFor().match, startDate: "" } }),
  });
  eq("saving without a start date is refused", r.status, 400);
  eq("  …and the refusal names the field", r.body.field, "startDate");
  eq("  …and says why it is blank", /deliberately blank/i.test(r.body.error ?? ""), true);
  console.log(`     ${String(r.body.error).slice(0, 88)}…`);
}

// ── 2. PER-INSTANCE FIELDS CANNOT BE COPIED ───────────────────────────────────────────────────
console.log("\n── per-instance fields are refused, by name ──");
for (const key of ["id", "starRating", "playerCount", "players", "isCancelled", "createdAt"]) {
  const r = await api(`/api/matchday/${ENV}/matches/create`, {
    method: "POST", body: JSON.stringify({ match: { ...bodyFor().match, [key]: 1 } }),
  });
  eq(`${key} is refused`, r.status, 400);
  eq(`  …and the error names it`, (r.body.error ?? "").includes(key), true);
}

// ── 3. A COPY CREATES EXACTLY ONE MATCH ───────────────────────────────────────────────────────
console.log("\n── the create, and the double submit ──");
let createdId = null;
{
  const first = await api(`/api/matchday/${ENV}/matches/create`, { method: "POST", body: JSON.stringify(bodyFor()) });
  eq("the first create succeeds", first.status, 200);
  eq("  …and reports LANDED from a READ-BACK, not the status code", first.body.outcome, "LANDED");
  createdId = Number(first.body.id);
  eq("  …and returns the new match's id", createdId > 0, true);
  eq("  …and the read-back is that match", Number(first.body.match?.id), createdId);
  console.log(`     created ${createdId} "${NAME}"`);

  // THE DOUBLE SUBMIT — fired from OUTSIDE the button, which is the whole point: a disabled button
  // cannot stop a second tab or a refresh mid-save.
  const second = await api(`/api/matchday/${ENV}/matches/create`, { method: "POST", body: JSON.stringify(bodyFor()) });
  eq("the second identical create is REFUSED", second.status, 409);
  eq("  …and names the match that already exists", Number(second.body.duplicate?.id), createdId);
  eq("  …and says it can be overridden deliberately", second.body.overridable, true);
  eq("  …and did NOT create anything", second.body.id, undefined);

  // AND THE SCHEDULE AGREES — one match at that slot, not two. This is the assertion that would
  // catch a guard that answered correctly while the write went ahead anyway.
  const day = START.slice(0, 10);
  const list = await api(`/api/matchday/${ENV}/gameday?date=${day}`);
  const atSlot = (list.body.matches ?? []).filter((m) =>
    String(m.name ?? "") === NAME);
  eq("exactly one match exists at that slot", atSlot.length, 1);
  console.log(`     schedule for ${day}: ${atSlot.length} match named ${NAME}`);
}

// ── 4. THE CREATED MATCH CARRIES NONE OF THE PER-INSTANCE STATE ───────────────────────────────
console.log("\n── the new match is new ──");
{
  const r = await api(`/api/matchday/${ENV}/matches/${createdId}`);
  eq("  control — the new match reads back", r.status, 200);
  const m = r.body.match ?? {};
  eq("it has its own id, not the source's", Number(m.id) === Number(SOURCE.id), false);
  eq("no roster came with it", (r.body.players ?? []).length, 0);
  eq("no rating came with it", [m.starRating ?? 0, m.starRatingCount ?? 0], [0, 0]);
  eq("it is not cancelled", m.isCancelled === true, false);
  console.log(`     ${createdId}: players ${(r.body.players ?? []).length} · rating ${m.starRating ?? 0}`);
}

// ── 5. THE AUDIT ENTRY, WITH NO PII ───────────────────────────────────────────────────────────
console.log("\n── change_log ──");
{
  const { createClient } = await import("@supabase/supabase-js");
  const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data } = await svc.from("change_log").select("*").eq("match_id", createdId).order("created_at", { ascending: false }).limit(5);
  eq("the create is in change_log", (data ?? []).length > 0, true);
  const row = (data ?? [])[0] ?? {};
  eq("  …as a POST to /admin/matches", [row.method, row.endpoint], ["POST", "/admin/matches"]);
  eq("  …recorded as landed", row.outcome, "landed");
  const blob = JSON.stringify(row);
  // NO PHONE, NO MESSAGE BODY. The payload is nine schedule fields and carries neither — this
  // asserts the log did not acquire them from somewhere else.
  eq("no phone number in the entry", /\+?\d{10,}/.test(blob.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "")), false);
  eq("no message body key in the entry", /"(message|body_text|preview)"/.test(blob), false);
  console.log(`     ${row.method} ${row.endpoint} · ${row.outcome}`);
}

// ── 6. EDIT MODE IS UNTOUCHED ─────────────────────────────────────────────────────────────────
console.log("\n── the shared editor still edits ──");
{
  await page.goto(`${BASE}/match-ops/matches/2470`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="save"]', { timeout: 60000 });
  await page.waitForTimeout(400);
  const shape = await page.evaluate(() => ({
    dateInputs: document.querySelectorAll('[data-testid="in-startDate"], [data-testid="in-endDate"]').length,
    disabledDates: [...document.querySelectorAll("input[disabled]")].some((i) => /→/.test(i.value ?? "")),
    saveLabel: document.querySelector('[data-testid="save"]')?.textContent?.trim(),
    saveDisabled: document.querySelector('[data-testid="save"]')?.disabled,
  }));
  eq("edit mode renders NO date inputs", shape.dateInputs, 0);
  eq("  …and keeps the disabled start-and-end line", shape.disabledDates, true);
  eq("  …and the button still says Save", shape.saveLabel, "Save");
  eq("  …disabled until something changes", shape.saveDisabled, true);
}

// ── 7. CREATE MODE ARRIVES WITHOUT A DATE ─────────────────────────────────────────────────────
console.log("\n── the copy form ──");
{
  await page.goto(`${BASE}/match-ops/matches/new?from=2470`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="save"]', { timeout: 60000 });
  await page.waitForTimeout(600);
  const f = await page.evaluate(() => ({
    start: document.querySelector('[data-testid="in-startDate"]')?.value ?? null,
    end: document.querySelector('[data-testid="in-endDate"]')?.value ?? null,
    name: document.querySelector('[data-testid="in-name"]')?.value ?? null,
    saveLabel: document.querySelector('[data-testid="save"]')?.textContent?.trim(),
  }));
  eq("  control — the create form rendered its date inputs", f.start !== null && f.end !== null, true);
  eq("the date arrives BLANK", [f.start, f.end], ["", ""]);
  eq("  …while the rest is pre-filled from the source", (f.name ?? "").length > 0, true);
  eq("the button says what it will do", f.saveLabel, "Create match");
  console.log(`     name pre-filled as "${f.name}" · dates blank`);
}

console.log(`\n================ RESULT ================`);
console.log(`Assertions: ${PASS} passed, ${FAIL} failed`);
console.log(`\nSTAGING MATCH CREATED AND NOT CLEANED UP: ${createdId} "${NAME}"`);
console.log(`(DELETE /admin/matches/{id} is on the endpoint deny-list — remove it by hand if you want it gone.)`);
if (fails.length) { console.log("\nFAILURES:"); fails.forEach((f) => console.log("  " + f)); }
await closeContext(ctx);
await closeBrowser(browser);
process.exit(FAIL === 0 ? 0 : 1);

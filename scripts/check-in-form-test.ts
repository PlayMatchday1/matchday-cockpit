/* CITY MANAGER CHECK-IN — the guard on the public write path and the month rules.
 *
 * WHY IT IS A NODE GUARD and not a browser look: this is a PUBLIC, no-login endpoint. The honeypot,
 * the rate limit and the validation are the only things standing between the open internet and an
 * insert, and every one of them is a refusal — the passing value is "nothing was written", which is
 * the shape of assertion that passes just as happily when the code does nothing at all. So each one
 * here carries a positive control proving it can still accept a good submission.
 *
 * The month rules are the second half. A check-in is ABOUT a month and is FILED in another one, and
 * the two disagree in SIX of the 12 real submissions. The overdue logic depends on keeping them
 * apart, and it is the thing a refactor would quietly break.
 *
 * Every constant here was measured against the published CSV on 2026-09-11: 12 rows, 14 headers,
 * ratings [3,4,5], five city spellings.
 */

import {
  validateCityCheckIn, isHoneypotTripped, parseMonthEnding, defaultMonthEnding,
  checkRateLimit, CHECK_IN_QUESTIONS, CHECK_IN_CITY_OPTIONS, RATING_OPTIONS,
  MAX_NAME_LEN, MAX_LONG_LEN, type RateLimitStore,
} from "../src/lib/cityCheckIns";
import { buildCheckInsData, checkInMonth, MANAGERS, type CheckInRecord } from "../src/lib/checkIns";
import { CITY_SCOPES } from "../src/lib/cityScope";

let pass = 0; const fails: string[] = [];
const ok = (m: string) => { pass++; console.log(`  ✓ ${m}`); };
const bad = (m: string, d = "") => { fails.push(`${m}${d ? ` — ${d}` : ""}`); console.log(`  ✗ ${m}${d ? ` — ${d}` : ""}`); };
const is = (m: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const GOOD = {
  manager_name: "Ben Faye",
  city_identifier: "ATL",
  month_ending: "2026-08-31",
  rating: 4,
  win: "Two new fields signed",
};

console.log("\nvalidation — a good submission is accepted, and that is the control for every refusal");
{
  const r = validateCityCheckIn(GOOD);
  if (r.ok) {
    ok("a well-formed check-in validates");
    is("the city is stored as the IDENTIFIER, not a display name", r.value.city_identifier, "ATL");
    is("month_ending survives as a date string", r.value.month_ending, "2026-08-31");
    is("an unanswered question is null, not an empty string", r.value.challenge, null);
    is("an answered one keeps its text", r.value.win, "Two new fields signed");
  } else bad("a well-formed check-in validates", r.error);
}

console.log("\nvalidation — the refusals");
{
  const refuses = (m: string, patch: Record<string, unknown>) => {
    const r = validateCityCheckIn({ ...GOOD, ...patch });
    if (!r.ok) ok(`${m} — refused: ${r.error}`);
    else bad(m, "ACCEPTED a payload it must refuse");
  };
  refuses("a missing city", { city_identifier: "" });
  refuses("a city that is not in cityScope", { city_identifier: "Atlanta" });
  refuses("El Paso, which has no city_identifier", { city_identifier: "ELP" });
  refuses("a missing month", { month_ending: "" });
  refuses("a month that is not a date", { month_ending: "August" });
  /* A REAL CALENDAR DATE, NOT A WELL-SHAPED STRING. "2026-02-31" passes a regex and is not a day;
   * Date would roll it forward to 2 March and store a month the manager never picked. */
  refuses("31 February, which is shaped like a date and is not one", { month_ending: "2026-02-31" });
  refuses("a rating of 0", { rating: 0 });
  refuses("a rating of 6", { rating: 6 });
  refuses("a rating of 4.5", { rating: 4.5 });
  refuses("an absurd rating", { rating: 99999 });
  refuses("a missing name", { manager_name: "   " });
  refuses("an over-length name", { manager_name: "x".repeat(MAX_NAME_LEN + 1) });
  refuses("an over-length answer", { win: "x".repeat(MAX_LONG_LEN + 1) });

  // The boundary is INCLUSIVE on both sides — an off-by-one here rejects a legitimate answer.
  const edge = validateCityCheckIn({ ...GOOD, win: "x".repeat(MAX_LONG_LEN) });
  if (edge.ok) ok(`exactly ${MAX_LONG_LEN} characters is still accepted`);
  else bad("the length cap is inclusive", edge.error);
  for (const n of RATING_OPTIONS) {
    const r = validateCityCheckIn({ ...GOOD, rating: n });
    if (!r.ok) bad(`rating ${n} is offered by the form and must validate`, r.error);
  }
  ok("every rating the form offers validates");
}

console.log("\nthe honeypot writes nothing, and does not refuse a human");
{
  if (isHoneypotTripped({ ...GOOD, website: "http://spam" })) ok("a filled hidden field is a bot");
  else bad("a filled hidden field is a bot");
  if (!isHoneypotTripped(GOOD)) ok("control: an untouched honeypot is NOT tripped");
  else bad("control: an untouched honeypot is NOT tripped", "every human would be dropped");
  if (!isHoneypotTripped({ ...GOOD, website: "   " })) ok("control: whitespace is not a bot");
  else bad("control: whitespace is not a bot");
}

console.log("\nthe rate limit refuses the 6th in the window, and only in the window");
{
  const store: RateLimitStore = new Map();
  const t0 = 1_700_000_000_000;
  let allowed = 0;
  for (let i = 0; i < 5; i++) if (checkRateLimit("1.2.3.4", store, t0 + i * 1000).allowed) allowed++;
  is("the first five are allowed", allowed, 5);
  const sixth = checkRateLimit("1.2.3.4", store, t0 + 6000);
  if (!sixth.allowed) ok(`the sixth is refused, Retry-After ${Math.ceil(sixth.retryAfterMs / 1000)}s`);
  else bad("the sixth is refused", "the limit does nothing");
  // Two controls: a different caller is unaffected, and the window actually expires.
  if (checkRateLimit("9.9.9.9", store, t0 + 6000).allowed) ok("control: a different IP is unaffected");
  else bad("control: a different IP is unaffected", "one bot would lock out every manager");
  if (checkRateLimit("1.2.3.4", store, t0 + 11 * 60 * 1000).allowed) ok("control: the window expires");
  else bad("control: the window expires", "a manager would be locked out permanently");
}

console.log("\nthe month a check-in is ABOUT is not the month it was FILED");
{
  /* SLICED, NOT PARSED. month_ending is a DATE. `new Date("2026-03-31")` is UTC midnight, which is
   * 30 March in every US timezone — reading the month off that files a month-end check-in into the
   * previous month. Both real rows below come from the imported twelve. */
  is("month-ending 31 Mar reads as March", checkInMonth("2026-03-31"), "2026-03");
  is("month-ending 30 Apr reads as April", checkInMonth("2026-04-30"), "2026-04");
  is("month-ending 30 Jun reads as June", checkInMonth("2026-06-30"), "2026-06");
  // The control: the naive parse really does disagree, so this is guarding something real.
  const naive = new Date("2026-03-31");
  const naiveMonth = `${naive.getFullYear()}-${String(naive.getMonth() + 1).padStart(2, "0")}`;
  if (naiveMonth !== "2026-03") ok(`control: the naive local parse says ${naiveMonth} — the trap is real`);
  else ok("control: this runner's timezone is UTC, so the naive parse happens to agree (still sliced)");
}

console.log("\nthe month-ending default is the month just COMPLETED");
{
  is("in September, the default is 31 August", defaultMonthEnding(new Date(2026, 8, 11)), "2026-08-31");
  is("in March, the default is 28 February", defaultMonthEnding(new Date(2026, 2, 3)), "2026-02-28");
  is("in a leap February, the default is 31 January", defaultMonthEnding(new Date(2024, 1, 9)), "2024-01-31");
  is("in January, the default is 31 December of last year", defaultMonthEnding(new Date(2026, 0, 4)), "2025-12-31");
  is("the default is always a real date", parseMonthEnding(defaultMonthEnding(new Date(2026, 8, 11))), "2026-08-31");
}

console.log("\nthe read side matches on cityId, and the overdue rule is unchanged");
{
  const row = (city: string, monthEnding: string, submitted: string): CheckInRecord => ({
    submitted_at: submitted, manager_name: "Someone", city_identifier: city,
    month_ending: monthEnding, rating: 4,
    fields_contacted: null, fields_list: null, field_progress: null, match_manager: null,
    marketing_channels: null, marketing_results: null, win: null, challenge: null, focus: null,
  });
  const now = new Date(2026, 8, 11); // 11 Sep 2026

  // ITEM 12, FIRST HALF: a city that filed nothing in the VIEWED month shows nothing.
  const augOnly = [row("ATL", "2026-08-31", "2026-09-02T14:00:00Z")];
  const sept = buildCheckInsData(augOnly, now, "2026-09");
  const atlSept = sept.statuses.find((s) => s.manager.cityId === "ATL");
  if (atlSept && atlSept.entry === null && !atlSept.submitted) ok("viewing September, an August-only city shows nothing");
  else bad("viewing September, an August-only city shows nothing", JSON.stringify(atlSept?.entry));

  /* ITEM 12, SECOND HALF, AND THE SUBTLE ONE. Stepping back to August, that same check-in must NOT
   * read as Overdue — it was filed on time for August. With a month selected, an entry existing IS
   * a submission; comparing its timestamp to THIS month's start is the bug this guards. */
  const aug = buildCheckInsData(augOnly, now, "2026-08");
  const atlAug = aug.statuses.find((s) => s.manager.cityId === "ATL");
  if (atlAug?.entry && atlAug.submitted) ok("stepping back to August, an on-time August check-in is NOT overdue");
  else bad("stepping back to August, an on-time August check-in is NOT overdue", JSON.stringify(atlAug));

  // Without a month: latest-ever, submitted only if it landed this calendar month.
  const noMonth = buildCheckInsData(augOnly, now);
  const atlAny = noMonth.statuses.find((s) => s.manager.cityId === "ATL");
  if (atlAny?.entry && atlAny.submitted) ok("with no month, a 2 Sep filing counts for September");
  else bad("with no month, a 2 Sep filing counts for September", JSON.stringify(atlAny));
  const old = buildCheckInsData([row("ATL", "2026-06-30", "2026-07-02T14:00:00Z")], now);
  const atlOld = old.statuses.find((s) => s.manager.cityId === "ATL");
  if (atlOld?.entry && !atlOld.submitted) ok("control: a July filing does NOT count for September");
  else bad("control: a July filing does NOT count for September", JSON.stringify(atlOld));

  // ATLANTA IS THE TEST CASE. The Sheet had no Atlanta row; a row keyed ATL must now reach Ben Faye.
  is("an ATL row reaches Ben Faye", atlAug?.manager.name, "Ben Faye");

  /* MATCHING IS EXACT ON THE IDENTIFIER. A display name in the column matches NOTHING now — which
   * is the entire point of the migration, and is why the CHECK constraint and the select exist. */
  const named = buildCheckInsData([row("Atlanta", "2026-08-31", "2026-09-02T14:00:00Z")], now, "2026-08");
  if (named.statuses.every((s) => s.entry === null)) ok("a display name in city_identifier matches nothing — no fuzzy fallback survives");
  else bad("a display name matches nothing", "the fuzzy matcher is still in play");

  // Latest-per-city, not first-seen.
  const two = buildCheckInsData([
    row("ATX", "2026-08-31", "2026-09-01T10:00:00Z"),
    row("ATX", "2026-08-31", "2026-09-05T10:00:00Z"),
  ], now, "2026-08");
  is("the LATEST submission for a city wins",
    two.statuses.find((s) => s.manager.cityId === "ATX")?.entry?.timestamp.toISOString(),
    "2026-09-05T10:00:00.000Z");

  // An empty table is every manager overdue, not a crash.
  const none = buildCheckInsData([], now, "2026-09");
  is("no rows means nobody submitted", [none.submittedCount, none.overdueCount], [0, MANAGERS.length]);
}

console.log("\nthe form and the validator cannot drift");
{
  is("nine questions are asked", CHECK_IN_QUESTIONS.length, 9);
  const keys = CHECK_IN_QUESTIONS.map((q) => q.key);
  is("every question has a distinct key", new Set(keys).size, keys.length);
  if (CHECK_IN_QUESTIONS.every((q) => q.max > 0)) ok("every question carries a length cap");
  else bad("every question carries a length cap");
  /* THE SELECT'S OPTIONS ARE THE ALLOWLIST. If these ever diverged, the form would offer a city
   * the route refuses — a manager filling in a long form and losing it on submit. */
  for (const c of CHECK_IN_CITY_OPTIONS) {
    const r = validateCityCheckIn({ ...GOOD, city_identifier: c.identifier });
    if (!r.ok) bad(`the form offers ${c.identifier} but the route refuses it`, r.error);
  }
  ok(`every city the form offers is accepted by the route (${CHECK_IN_CITY_OPTIONS.length})`);
  if (CHECK_IN_CITY_OPTIONS.length >= MANAGERS.length) ok("the city list is at least as wide as the manager roster");
  else bad("the city list is at least as wide as the manager roster", "a city could not file");
}

console.log("\nthe city allowlist lives in CODE — this replaces the dropped CHECK constraint (0168)");
{
  /* 0167 put a CHECK listing eight abbreviations on city_identifier; 0168 drops it, because
   * cityScope.ts had already settled that question for this column (0120: "a CHECK listing today's
   * seven abbreviations is a migration every time a city opens"). The guarantee MOVES here rather
   * than disappearing, so this is the test that has to hold.
   *
   * DERIVED FROM CITY_SCOPES, NEVER LISTED. A hardcoded set here would recreate exactly the second
   * list the migration exists to delete, and would go stale the day a ninth city opens. */
  let accepted = 0;
  for (const c of CITY_SCOPES) {
    const r = validateCityCheckIn({ ...GOOD, city_identifier: c.identifier });
    if (r.ok && r.value.city_identifier === c.identifier) accepted++;
    else bad(`CITY_SCOPES carries ${c.identifier} but the route refuses it`, r.ok ? "stored a different value" : r.error);
  }
  is("every identifier in CITY_SCOPES is accepted", accepted, CITY_SCOPES.length);

  /* THE REFUSAL, which is the half the database used to own. Each of these is a real shape: a
   * display name, a lowercase abbreviation, one with trailing whitespace, an empty string, and a
   * city that does not exist. cityScope.ts's resolveCityScope is EXACT match only — no trimming,
   * no upper-casing — and the validator must not be looser than the list it reads. */
  for (const junk of ["NOPE", "Atlanta", "atl", "ATL ", " ATL", "", "ELP", "XX", "DFW;DROP"]) {
    const r = validateCityCheckIn({ ...GOOD, city_identifier: junk });
    if (r.ok) bad(`an unknown identifier ${JSON.stringify(junk)} must be refused`, "ACCEPTED");
  }
  ok("every unknown identifier is refused, including case and whitespace near-misses");

  // CONTROL: the loop above can actually fail — a known-good value must still pass through it.
  const control = validateCityCheckIn({ ...GOOD, city_identifier: CITY_SCOPES[0].identifier });
  if (control.ok) ok(`control: ${CITY_SCOPES[0].identifier} passes the same path that refused the junk`);
  else bad("control: a known identifier passes", control.error);
}

console.log(`\ncheck-in-form: ${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log(`  FAILED: ${f}`); process.exit(1); }

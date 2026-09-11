// THE VEO DAY VIEW, DRIVEN AS THE CONFINED WARSAW ACCOUNT.
//   node scripts/e2e/verify-veo-confined.mjs      (needs `npm run dev` up)
//
// WHY THIS IS ITS OWN FILE AND NOT A BLOCK IN verify-city-confinement.mjs. It was written there
// first, in the Warsaw section, and could not be reached: that suite times out (exit 2, a
// Playwright wait on /city/gameday) about two hundred lines earlier, on a clean tree, unrelated to
// anything here. A block behind a wall that never opens is an assertion nobody runs. These checks
// need no browser at all — they are route calls with a session token — so they run on their own.
//
// TWO THINGS, AND THEY ARE NOT THE SAME CHECK:
//   the route OPENS for a confined account (it is on the exact allowlist — a refusal here is a
//   page the operator cannot use), and what it RETURNS is their city and nothing else (a route
//   that opens and hands back Austin is the leak).
//
// AND A CONTROL, because "every row is Warsaw's" passes trivially on a day that is all Warsaw:
// an admin asking for the same day must see more than one city.
import { netRetry, installHarnessGuard, fatal, sessionFor } from "./_session.mjs";
import { createClient } from "@supabase/supabase-js";
installHarnessGuard();

const BASE = process.env.BASE || "http://localhost:3000";
const WAW_EMAIL = "jf@playmatchday.pl";
const ADMIN = "rmancuso@playmatchday.com";
const OTHER_CITY = "DFW";

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const yes = (n, c, d = "") => (c ? ok(n) : bad(n, d));
const get = async (path, token) => {
  const r = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
  return { status: r.status, ok: r.ok, body: await r.json().catch(() => ({})) };
};
const citiesOf = (b) => [...new Set((b.rows ?? []).map((r) => r.cityCode).filter(Boolean))];

async function main() {
  process.loadEnvFile(".env.local");
  const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  const { data: row } = await netRetry(
    () => svc.from("app_users").select("email,city_identifier,is_admin,can_access_matchops").eq("email", WAW_EMAIL).maybeSingle(),
    "waw app_users row");
  if (row?.city_identifier !== "WAW" || row?.is_admin !== false) {
    bad("the account under test is WAW-confined and not an admin", JSON.stringify(row));
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(1);
  }
  ok("the account under test really is WAW-confined and not an admin");

  /* WHAT WARSAW ACTUALLY HAS, MEASURED, because it changes what these assertions can mean.
   * All 9 of Warsaw's 2026 matches sit on mdapi field 1684, all 9 carry the camera emoji, and NO
   * veo_codes row names 1684. So the confined Veo page is legitimately EMPTY: no recording can
   * arrive for a field no code names. That makes "every row is Warsaw's" vacuous — it is satisfied
   * by zero rows — so the boundary is asserted the other way round instead: on a day when the
   * admin sees camera matches in several cities, the confined account must see NONE of them. */
  const { data: codeRows } = await svc.from("veo_codes").select("code, city, field_ids");
  const cameraFields = [...new Set(codeRows.flatMap((r) => (r.field_ids ?? []).map(Number)))];
  const { data: wawAll } = await svc.from("mdapi_matches")
    .select("field_id, name").eq("city_identifier", "WAW").is("deleted_at", null).gte("start_date", "2026-01-01");
  const wawFields = [...new Set((wawAll ?? []).map((m) => m.field_id))];
  const wawCoded = wawFields.filter((f) => cameraFields.includes(f));
  const wawEmoji = (wawAll ?? []).filter((m) => /\u{1F3A5}/u.test(m.name ?? "")).length;
  console.log(`     Warsaw 2026: ${(wawAll ?? []).length} matches on field(s) ${JSON.stringify(wawFields)}, ${wawEmoji} with the camera emoji`);
  console.log(`     veo_codes names ${cameraFields.length} fields across ${new Set(codeRows.map((r) => r.city)).size} cities; ${wawCoded.length} of them are Warsaw's`);

  /* THE DAY: one where the ADMIN has camera matches, so "the confined account sees none of them"
   * is a real exclusion and not an empty day. DERIVED, not pinned. */
  const { data: busy } = await svc.from("mdapi_matches")
    .select("start_date").is("deleted_at", null).in("field_id", cameraFields)
    .neq("city_identifier", "WAW").order("start_date", { ascending: false }).limit(400);
  const dayCount = {};
  for (const m of busy ?? []) { const d = String(m.start_date).slice(0, 10); dayCount[d] = (dayCount[d] ?? 0) + 1; }
  const DAY = Object.entries(dayCount).sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!DAY) { bad("a day with camera matches to test against", "none found"); console.log(`\n${pass} passed, ${fail} failed`); process.exit(1); }
  ok(`testing against ${DAY} — the busiest camera day (${dayCount[DAY]} matches outside Warsaw)`);

  const waw = await sessionFor(WAW_EMAIL);
  const admin = await sessionFor(ADMIN);

  const day = await get(`/api/veo/day?date=${DAY}`, waw.access_token);
  yes("the Veo day view OPENS for the confined account", day.ok, `status ${day.status}: ${JSON.stringify(day.body.error)}`);
  const adminDay = await get(`/api/veo/day?date=${DAY}`, admin.access_token);
  const ac = citiesOf(adminDay.body);

  // THE CONTROL COMES FIRST, so the exclusion below is measured against something that exists.
  yes(`control — an admin sees ${(adminDay.body.rows ?? []).length} camera matches across ${ac.length} cities on ${DAY} (${JSON.stringify(ac)})`,
    adminDay.ok && (adminDay.body.rows ?? []).length > 0 && ac.length > 1,
    `status ${adminDay.status}, ${(adminDay.body.rows ?? []).length} rows, cities ${JSON.stringify(ac)}`);

  if (day.ok) {
    const c = citiesOf(day.body);
    const n = (day.body.rows ?? []).length;
    console.log(`     the confined account sees ${n} row(s): ${JSON.stringify(c)}`);
    yes("…and NONE of the admin's rows reach it — every one of them is another city's",
      c.every((x) => x === "WAW"), `saw ${JSON.stringify(c)}`);
    yes("…and the payload names the city it is confined to", day.body.confinedCity === "WAW", JSON.stringify(day.body.confinedCity));
    yes("…and the tally counts exactly the rows it returned",
      day.body.tally?.total === n, `tally ${JSON.stringify(day.body.tally)} vs ${n} rows`);

    // A CITY PARAMETER MUST NOT WIDEN IT. The scope is the session's; asking for another city has
    // to be ignored rather than honoured, or the filter is a suggestion.
    const wider = await get(`/api/veo/day?date=${DAY}&city=${OTHER_CITY}`, waw.access_token);
    const wc = citiesOf(wider.body);
    yes(`…and a ?city=${OTHER_CITY} parameter cannot widen it`,
      wider.ok && wc.every((x) => x === "WAW") && (wider.body.rows ?? []).length === n,
      `status ${wider.status}, ${(wider.body.rows ?? []).length} rows, cities ${JSON.stringify(wc)}`);
  }

  /* AND THE PAGE SAYS WHY IT IS EMPTY. A blank day and a day whose matches are on an uncoded field
   * look identical, and the second one is a configuration gap somebody should close. On a Warsaw
   * day the payload carries the count of camera-emoji matches sitting on a field no code names. */
  const { data: wawDayRow } = await svc.from("mdapi_matches")
    .select("start_date").eq("city_identifier", "WAW").is("deleted_at", null)
    .order("start_date", { ascending: false }).limit(1);
  if (wawDayRow?.length) {
    const WAW_DAY = String(wawDayRow[0].start_date).slice(0, 10);
    const wd = await get(`/api/veo/day?date=${WAW_DAY}`, waw.access_token);
    /* FIELD-PATH EDIT, itemised (2026-09-11): the route returns the matches themselves as
     * `emojiMatches` — its own comment says the count became rows — so `emojiWithoutCode` read
     * undefined and this assertion had been failing on a field that no longer exists. Same claim,
     * read off the rows. */
    const emojiN = (wd.body.emojiMatches ?? []).length;
    console.log(`     Warsaw's own day ${WAW_DAY}: ${(wd.body.rows ?? []).length} rows, ${emojiN} emoji-only match(es)`);
    yes("on Warsaw's own match day the page reports the uncoded camera matches rather than looking empty",
      wd.ok && emojiN > 0, `emojiMatches=${emojiN}`);

    /* THE CANDIDATE LIST IS CONFINED TOO. It now carries every match on the day, not only coded
     * ones — so a Crossbar-style film can be assigned — and it must still come only from this
     * account's city. Warsaw's own day is the POSITIVE control: its uncoded match IS a candidate. */
    const wCands = Object.values(wd.body.candidates ?? {});
    yes("Warsaw's own uncoded match is a candidate on its own day", wCands.some((c) => c.city === "Warsaw" && c.coded === false),
      JSON.stringify(wCands.map((c) => `${c.apiId} ${c.city} coded=${c.coded}`)));
    yes("…and every candidate it is offered is Warsaw's", wCands.length > 0 && wCands.every((c) => c.city === "Warsaw"),
      JSON.stringify([...new Set(wCands.map((c) => c.city))]));
    /* AND ON THE BUSIEST OTHER-CITY DAY, NOTHING. Before the fix this account was handed another
     * city's recordings as `unplaced` and their matches as candidates, through a stray lookup with
     * no city filter. CONTROL: the admin's candidates on the same day span several cities. */
    const busy = await get(`/api/veo/day?date=${DAY}`, waw.access_token);
    const bCands = Object.values(busy.body.candidates ?? {});
    const aCands = [...new Set(Object.values(adminDay.body.candidates ?? {}).map((c) => c.city))];
    yes(`control — the admin's candidates on ${DAY} span several cities`, aCands.length > 1, JSON.stringify(aCands));
    yes(`…and the confined account is offered none of them`, busy.ok && bCands.every((c) => c.city === "Warsaw"),
      JSON.stringify(bCands.map((c) => `${c.apiId} ${c.city}`)));
    /* THE UNPLACED CHECK NEEDS A DAY WITH RECORDINGS ON IT — the busiest camera day is often in the
     * future, where zero unplaced proves nothing. Derived: the latest date that non-dismissed
     * recordings parsed to. CONTROL: those recordings exist (counted with the service key). */
    const { data: recDay } = await svc.from("veo_recordings").select("parsed_match_date")
      .neq("status", "dismissed").not("parsed_match_date", "is", null).order("parsed_match_date", { ascending: false }).limit(1);
    const REC_DAY = recDay?.[0]?.parsed_match_date;
    const { count: recN } = await svc.from("veo_recordings").select("id", { count: "exact", head: true })
      .eq("parsed_match_date", REC_DAY).neq("status", "dismissed");
    yes(`control — ${recN} recording(s) parsed to ${REC_DAY}, none of them Warsaw's`, (recN ?? 0) > 0, `${recN}`);
    const rd = await get(`/api/veo/day?date=${REC_DAY}`, waw.access_token);
    yes(`…and the confined account is handed none of them as unplaced`, rd.ok && (rd.body.unplaced ?? []).length === 0,
      JSON.stringify((rd.body.unplaced ?? []).map((u) => u.subject)));
    yes(`…nor offered another city's match for them`, rd.ok && Object.values(rd.body.candidates ?? {}).every((c) => c.city === "Warsaw"),
      JSON.stringify(Object.values(rd.body.candidates ?? {}).map((c) => `${c.apiId} ${c.city}`)));
  } else bad("Warsaw has a match day to check", "no WAW matches at all");

  // OPENING THE DOOR MUST NOT HAVE OPENED THE BUILDING. The camera-code admin surface stays shut.
  const codes = await get("/api/veo/codes", waw.access_token);
  yes("an out-of-scope Veo route is still refused (/api/veo/codes → 403)", codes.status === 403, `got ${codes.status}`);
  const thumb = await get("/api/veo/thumb?id=00000000-0000-0000-0000-000000000000", waw.access_token);
  yes("…and the thumbnail route opens for them (it is part of the page)", thumb.ok, `got ${thumb.status}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch(fatal);

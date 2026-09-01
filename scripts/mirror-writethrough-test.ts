// THE MIRROR WRITE-THROUGH — one implementation, every caller, and the four rules that keep it safe.
//
// ITEMISED: this file was veo-mirror-writethrough-test.ts and asserted on an INLINE block in the
// match-edit route, because the write-through lived there. Manager assignment needed the same
// thing, so it moved to src/lib/mirrorWriteThrough.ts and these assertions moved with it — from
// "the route contains this code" to "the function behaves, and every caller uses it".
//
// mdapi_matches is a read-only mirror of PRODUCTION MatchDay refreshed by ONE daily cron
// (vercel.json "0 11 * * *"). Every Clubhouse screen reads names and managers from it, so a write
// that does not refresh the row is invisible for up to ~24 hours. Measured: 6 of 6 landed Veo name
// writes were still absent from the mirror an hour later.
//
//   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/mirror-writethrough-test.ts

import { readFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { refreshMatchMirror, insertMatchMirror } from "../src/lib/mirrorWriteThrough";

let PASS = 0, FAIL = 0;
const ok = (n: string) => { PASS++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { FAIL++; console.log(`  XX  ${n} — ${d}`); };
const is = (n: string, got: unknown, want: unknown) =>
  (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

// A Supabase stand-in that records what it was asked to write.
function fakeSb() {
  const calls: { table: string; patch: Record<string, unknown>; id: unknown }[] = [];
  const sb = {
    from(table: string) {
      return { update(patch: Record<string, unknown>) {
        return { async eq(_c: string, id: unknown) { calls.push({ table, patch, id }); return { error: null }; } };
      } };
    },
  };
  return { sb: sb as never, calls };
}

/* synced_at IS NOW PART OF EVERY PATCH (2026-09-01) and is a timestamp, so the fixtures compare
 * the mirrored FIELDS and check the stamp on its own. Freezing a clock into an equality would
 * make this file fail once a second. */
const stripStamp = (o: Record<string, unknown>) => { const { synced_at, ...rest } = o; void synced_at; return rest; };
const hasStamp = (o: Record<string, unknown>) => typeof o.synced_at === "string" && o.synced_at.length >= 20;

const AFTER_NAME = { name: "\u{1F3A5} NEMP - Field 13", managerId: 7, manager: { firstName: "Abra", lastName: "Cadabra", email: "a@x.com" } };
const AFTER_MGR = { name: "NEMP - Field 13", managerId: 42, manager: { firstName: "Chris", lastName: "Padilla", email: "c@x.com" } };

// tsx emits CJS here, where top-level await is unavailable — the whole run lives in main().
async function main() {
  console.log("a LANDED write refreshes the row from the READ-BACK value:");
  {
    const { sb, calls } = fakeSb();
    const r = await refreshMatchMirror(sb, "production", 18115, ["name"], AFTER_NAME, "landed");
    is("it reports refreshed", r.refreshed, true);
    is("  …one update, to mdapi_matches, keyed on api_id", { n: calls.length, t: calls[0]?.table, id: calls[0]?.id }, { n: 1, t: "mdapi_matches", id: 18115 });
    is("  …carrying the read-back name and nothing else", stripStamp(calls[0].patch), { name: "\u{1F3A5} NEMP - Field 13" });
    is("  …and stamps synced_at, so the freshness readout moves with it", hasStamp(calls[0].patch), true);
  }
  {
    const { sb, calls } = fakeSb();
    await refreshMatchMirror(sb, "production", 991, ["managerId"], AFTER_MGR, "landed");
    // The manager NAME is denormalised into the mirror: an id-only update would show the new id
    // beside the OLD person on every screen that reads those columns.
    is("a manager assignment refreshes id AND the denormalised name/email", stripStamp(calls[0].patch),
       { manager_id: 42, manager_first_name: "Chris", manager_last_name: "Padilla", manager_email: "c@x.com" });
  }

  console.log("\nand it refuses, in each of the three ways it must:");
  for (const [label, env, outcome] of [
    ["a FAILED write", "production", "failed"],
    ["a NOT APPLIED write", "production", "not applied"],
    ["an UNKNOWN write", "production", "unknown"],
    ["a STAGING write, even when it landed", "staging", "landed"],
  ] as [string, string, string][]) {
    const { sb, calls } = fakeSb();
    const r = await refreshMatchMirror(sb, env, 18115, ["name"], AFTER_NAME, outcome);
    is(`  ${label} → no update at all`, { refreshed: r.refreshed, calls: calls.length }, { refreshed: false, calls: 0 });
  }
  // POSITIVE CONTROL for those four zeros: the same harness DOES record an update when it should.
  {
    const { sb, calls } = fakeSb();
    await refreshMatchMirror(sb, "production", 1, ["name"], AFTER_NAME, "landed");
    is("  control — the harness records an update when the write is production + landed", calls.length, 1);
  }

  console.log("\nit never guesses:");
  {
    /* ── CHANGED 2026-09-01 (assertion body, itemised) ────────────────────────────────────────
     * The fixture used registrationPrice as "a field the mirror does not carry". It carries it
     * now — the COLUMN map went from four entries to twenty because a four-entry map is what let
     * an edited START TIME write through as a silent no-op. So the fixture moved to a field that
     * is GENUINELY unmirrored: managerIntro is writable by the editor and mdapi_matches has no
     * column for it. The property under test is unchanged — an unmapped key is skipped, not
     * guessed at. */
    const { sb, calls } = fakeSb();
    const r = await refreshMatchMirror(sb, "production", 1, ["managerIntro"], { managerIntro: "hi" }, "landed");
    is("a field the mirror does not carry is skipped", { refreshed: r.refreshed, calls: calls.length }, { refreshed: false, calls: 0 });
    // CONTROL: the field that USED to stand for "unmirrored" is now mirrored, and must write.
    const { sb: sb2, calls: c2 } = fakeSb();
    const r2 = await refreshMatchMirror(sb2, "production", 1, ["registrationPrice"], { registrationPrice: 1200 }, "landed");
    is("control: registrationPrice IS mirrored now", { refreshed: r2.refreshed, patch: stripStamp(c2[0]?.patch ?? {}) },
       { refreshed: true, patch: { registration_price: 1200 } });
    /* AND THE ONE THAT CAUSED THIS WHOLE FIX. An edited start time must reach the mirror, because
     * Master Schedule renders start_date out of it. */
    const { sb: sb3, calls: c3 } = fakeSb();
    const r3 = await refreshMatchMirror(sb3, "production", 1, ["startDate", "endDate"],
      { startDate: "2026-09-04T19:00:00.000Z", endDate: "2026-09-04T20:00:00.000Z" }, "landed");
    is("START TIME reaches the mirror — the bug this map had", { refreshed: r3.refreshed, patch: stripStamp(c3[0]?.patch ?? {}) },
       { refreshed: true, patch: { start_date: "2026-09-04T19:00:00.000Z", end_date: "2026-09-04T20:00:00.000Z" } });
    // ...stored VERBATIM. A Date anywhere on this path would re-shift a wall-clock string.
    is("  …byte-identical to the read-back, no Date constructed",
      (c3[0]?.patch as Record<string, unknown>).start_date, "2026-09-04T19:00:00.000Z");
    // A fieldId change denormalises the field's title, the way managerId does the manager's name.
    const { sb: sb4, calls: c4 } = fakeSb();
    await refreshMatchMirror(sb4, "production", 1, ["fieldId"],
      { fieldId: 77, field: { title: "NEMP - Field 13", address: "A", zipCode: "78726" } }, "landed");
    is("a fieldId change carries the field's title too", stripStamp(c4[0]?.patch ?? {}),
       { field_id: 77, field_title: "NEMP - Field 13", field_address: "A", field_zipcode: "78726" });
  }
  {
    const { sb, calls } = fakeSb();
    const r = await refreshMatchMirror(sb, "production", 1, ["name"], {}, "landed");
    is("a key the re-read did NOT return is skipped rather than nulled", { refreshed: r.refreshed, calls: calls.length }, { refreshed: false, calls: 0 });
  }
  {
    // Best-effort: a mirror error must never surface as a failure of the write that already landed.
    const sb = { from: () => ({ update: () => ({ eq: async () => ({ error: { message: "boom" } }) }) }) } as never;
    const r = await refreshMatchMirror(sb, "production", 1, ["name"], AFTER_NAME, "landed");
    is("a mirror failure is reported, not thrown", { refreshed: r.refreshed, reason: r.reason }, { refreshed: false, reason: "boom" });
  }

  console.log("\na CREATED match gets a ROW, not a patch that matches nothing:");
{
  const CREATED = {
    id: 9001, fieldId: 77, name: "New match", type: "REGULAR", category: "OPEN", description: "d",
    startDate: "2031-11-05T19:00:00.000Z", startDateUtc: "2031-11-06T01:00:00.000Z",
    endDate: "2031-11-05T20:00:00.000Z", endDateUtc: "2031-11-06T02:00:00.000Z",
    maxPlayerCount: 16, minPlayerCount: 0, registrationPrice: 1500, isCancelled: false,
    field: { title: "NEMP", address: "A", zipcode: 78726, city: { abbr: "ATX", name: "Austin" } },
    _count: { players: 0 },
  };
  const fakeIns = () => { const rows: Record<string, unknown>[] = []; 
    return { rows, sb: { from: () => ({ upsert: async (r: Record<string, unknown>) => { rows.push(r); return { error: null }; } }) } } as never as { rows: Record<string, unknown>[]; sb: never }; };

  { const { rows, sb } = fakeIns();
    const r = await insertMatchMirror(sb, "production", CREATED, "landed");
    is("it inserts", { inserted: r.inserted, writes: rows.length }, { inserted: true, writes: 1 });
    const row = rows[0];
    /* THE ONE THAT MATTERS. start_date is LOCAL WALL CLOCK despite the Z; a Date anywhere on this
     * path re-shifts it and a late-evening match lands on the wrong day. */
    is("  start_date is BYTE-IDENTICAL to the read-back", row.start_date, CREATED.startDate);
    is("  …and end_date", row.end_date, CREATED.endDate);
    is("  the field is denormalised", [row.field_id, row.field_title, row.city_identifier], [77, "NEMP", "ATX"]);
    is("  the NOT NULL columns are all filled", [row.api_id, row.field_id, row.raw != null, typeof row.synced_at], [9001, 77, true, "string"]);
    /* THE ONE COLUMN THE SINGLE-GET CANNOT FILL. _count carries players and NOT fakePlayers —
     * measured on staging and production — so it is NULL, never a guessed 0. Every consumer
     * coalesces it (managerPayCompute:313/:481, managerYearReport:70, ChatPane:74). */
    is("  fake_player_count is NULL, not a guessed 0", row.fake_player_count, null);
    is("  …and player_count comes from the read-back", row.player_count, 0);
    // CONTROL: the row is not mostly-null — an insert that filled nothing would also "pass" above.
    const filled = Object.values(row).filter((v) => v !== null && v !== undefined).length;
    if (filled >= 20) ok(`  control: ${filled} columns filled, so the row is real`);
    else bad("control: the inserted row is populated", `only ${filled} — AN EMPTY ROW WOULD PASS THE CHECKS ABOVE`);
  }
  { const { rows, sb } = fakeIns();
    const r = await insertMatchMirror(sb, "staging", CREATED, "landed");
    is("a STAGING create does not touch the production mirror", { inserted: r.inserted, reason: r.reason, writes: rows.length },
       { inserted: false, reason: "not production", writes: 0 }); }
  { const { rows, sb } = fakeIns();
    const r = await insertMatchMirror(sb, "production", CREATED, "unknown");
    is("an UNKNOWN create inserts nothing", { inserted: r.inserted, writes: rows.length }, { inserted: false, writes: 0 }); }
  { const { rows, sb } = fakeIns();
    const r = await insertMatchMirror(sb, "production", { ...CREATED, fieldId: null }, "landed");
    is("a read-back with no fieldId is REFUSED — field_id is NOT NULL in the schema",
       { inserted: r.inserted, reason: r.reason, writes: rows.length }, { inserted: false, reason: "no fieldId in the read-back", writes: 0 }); }
  { const sb = { from: () => ({ upsert: async () => ({ error: { message: "boom" } }) }) } as never;
    const r = await insertMatchMirror(sb, "production", CREATED, "landed");
    is("a failing insert is REPORTED, not thrown", { inserted: r.inserted, reason: r.reason }, { inserted: false, reason: "boom" }); }
  // It UPSERTS, so a cron that raced us is not reported as a mirror failure.
  const LIB = readFileSync("src/lib/mirrorWriteThrough.ts", "utf8");
  is("it upserts on api_id rather than a bare insert", /upsert\(row, \{ onConflict: "api_id" \}\)/.test(LIB), true);
  // And it uses the SYNC'S mapper, not a second hand-written one.
  is("the row comes from the sync's own mapMatchToRow", /await import\("\.\/mdapiMatchesSync"\)/.test(LIB), true);
  if (!/start_date:\s*[^m]/.test(LIB.slice(LIB.indexOf("insertMatchMirror")))) ok("…so no column is mapped by hand in the insert");
  else bad("the insert maps no column by hand", "A SECOND MAPPER IS A SECOND PLACE FOR THE WALL-CLOCK RULE TO DRIFT");
}

console.log("\nthe two paths that had no write-through now have one:");
{
  const CREATE = readFileSync("src/app/api/matchday/[env]/matches/create/route.ts", "utf8");
  is("create calls insertMatchMirror", /await insertMatchMirror\(auth\.supabase, env, created, "landed"\)/.test(CREATE), true);
  is("  …from the read-back it already classified the outcome from", /created && outcome === "LANDED"/.test(CREATE), true);
  is("  …and reports the result", /mirrored: mirror\.inserted/.test(CREATE), true);
  const CV = readFileSync("src/app/api/matchday/[env]/matches/[id]/convert-4/route.ts", "utf8");
  is("convert-4 calls refreshMatchMirror", /refreshMatchMirror\(\s*auth\.supabase, env, Number\(id\)/.test(CV), true);
  is("  …with the spot-count keys", /"maxPlayerCount", "maxTeamSize4Team", "maxTeamSize2Team"/.test(CV), true);
  is("  …only AFTER the shape write landed", CV.indexOf("if (!shapeOk)") < CV.indexOf("refreshMatchMirror("), true);
  is("  …and reports the result", /mirrored, mirrorReason,/.test(CV), true);
  // Neither may block the write it follows.
  /* THE CALL SITE, NOT THE IMPORT. indexOf("insertMatchMirror") finds the import at the top of
   * the file, which is before everything — the check passed on nothing. Anchored on the actual
   * invocation instead. */
  is("control: create's mirror call is after the audit and before the response",
     CREATE.indexOf("await insertMatchMirror(") > CREATE.indexOf("logged = true")
     && CREATE.indexOf("await insertMatchMirror(") < CREATE.indexOf("return Response.json({\n      ok: outcome"), true);
  // THE UI SAYS SO. A silent mirror failure is the thing this whole pass exists to remove.
  const ED = readFileSync("src/app/(internal)/match-ops/matches/[id]/MatchEditor.tsx", "utf8");
  is("the create screen surfaces a failed mirror insert", /the Clubhouse copy was not/.test(ED), true);
  const MP = readFileSync("src/components/MatchPanel.tsx", "utf8");
  is("the drawer surfaces a failed convert mirror", /STILL SHOWS THE OLD SPOT COUNT/.test(MP), true);
  is("  …and a failed edit mirror", /THE CLUBHOUSE COPY WAS NOT UPDATED/.test(MP), true);
}

console.log("\nthe map covers what Master Schedule renders — the reason this bug existed:");
{
  const LIB = readFileSync("src/lib/mirrorWriteThrough.ts", "utf8");
  const SCHED = readFileSync("src/lib/veoSchedule.ts", "utf8");
  /* MASTER SCHEDULE'S SELECT IS THE SPEC. Whatever it renders out of the mirror must be write-
   * through-able, or an edit to that field is invisible until the daily cron. It selected five
   * columns and the map covered two of them. */
  const sel = /\.select\("([^"]*api_id[^"]*)"\)/.exec(SCHED)?.[1] ?? "";
  const rendered = sel.split(",").map((c) => c.trim())
    .filter((c) => !["api_id", "deleted_at", "synced_at", "city_identifier"].includes(c));
  if (rendered.length >= 4) ok(`control: read ${rendered.length} rendered columns out of veoSchedule: ${rendered.join(", ")}`);
  else bad("control: the veoSchedule select was parsed", `got ${JSON.stringify(rendered)} — THE CHECK BELOW WOULD BE VACUOUS`);
  /* A COLUMN IS REACHABLE TWO WAYS, and both count: a COLUMN map entry, or a DENORMALISED
   * assignment (`patch.field_title = …`). field_title has no map entry — it rides on a fieldId
   * change, the same way manager_first_name rides on managerId — and the first version of this
   * check flagged it, correctly, for looking only at the map. */
  for (const col of rendered) {
    if (new RegExp(`: "${col}"`).test(LIB) || new RegExp(`patch\\.${col} =`).test(LIB)) ok(`  ${col} is write-through-able`);
    else bad(`${col} is write-through-able`, "MASTER SCHEDULE RENDERS IT AND AN EDIT WOULD NOT REACH IT UNTIL THE NIGHTLY CRON");
  }
  // CONTROL: a column the mirror genuinely cannot write must still fail the same scan.
  if (!/: "star_rating"/.test(LIB) && !/patch\.star_rating =/.test(LIB)) ok("  control: an unwritten column (star_rating) is NOT reachable — the scan can say no");
  else bad("control: the scan can report a column as unreachable", "IT WOULD PASS ON ANYTHING");
  // The stamp the page reads its freshness from must move when the mirror does.
  if (/patch\.synced_at = new Date\(\)\.toISOString\(\)/.test(LIB)) ok("a write-through stamps synced_at, so the freshness readout moves with the data");
  else bad("the write-through stamps synced_at", "THE PAGE WOULD REPORT THE CRON'S TIME OVER DATA THE CRON NEVER SAW");
  // And the fields with no column are named, so the next reader does not have to re-derive them.
  if (/NOT MIRRORED, AND DELIBERATELY SO/.test(LIB)) ok("…and the unmirrored fields are named, not left to be rediscovered");
  else bad("the unmirrored fields are documented");
}

console.log("\nevery caller uses the SHARED function — no second implementation:");
  for (const [label, f] of [
    ["match edit (name, managers, everything)", "src/app/api/matchday/[env]/matches/[id]/route.ts"],
    ["city manager assign", "src/app/api/manager-pay/city-week/route.ts"],
  ] as [string, string][]) {
    const code = stripComments(readFileSync(f, "utf8"));
    is(`  ${label} calls refreshMatchMirror`, /refreshMatchMirror\(/.test(code), true);
    is(`  ${label} does not update mdapi_matches itself`, /from\("mdapi_matches"\)[\s\S]{0,40}\.update\(/.test(code), false);
  }
  {
    // The env gate must be the FIRST thing the function checks — an ungated refresh rewrites a
    // production row from a staging action, which nearly shipped once.
    const lib = stripComments(readFileSync("src/lib/mirrorWriteThrough.ts", "utf8"));
    is("the env gate precedes the outcome gate, which precedes the update",
       lib.indexOf('env !== "production"') < lib.indexOf('outcome !== "landed"')
       && lib.indexOf('outcome !== "landed"') < lib.indexOf('from("mdapi_matches")'), true);
    is("  control — the scan sees all three markers", 
       lib.includes('env !== "production"') && lib.includes('outcome !== "landed"') && lib.includes('from("mdapi_matches")'), true);
  }
  {
    // The assign route must refresh BEFORE it responds, or the client's refetch reads the stale row.
    const code = stripComments(readFileSync("src/app/api/manager-pay/city-week/route.ts", "utf8"));
    is("the assign route refreshes the mirror BEFORE it responds",
       code.indexOf("refreshMatchMirror(") < code.indexOf("return Response.json({\n      ok: true"), true);
  }

}

await_main();
function await_main() { void main().then(() => {
console.log(`\n${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
}); }

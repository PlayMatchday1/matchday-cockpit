/* ONE-TIME IMPORT of Ryan's 2026 goal sheet into field_goal_rows / _targets / _actions.
 *
 *   npx tsx scripts/seed-field-goals.mts            # dry run: prints every mapping, writes nothing
 *   npx tsx scripts/seed-field-goals.mts --apply    # writes
 *
 * THE NAME MATCH HAPPENS ONCE, HERE, AND IS PRINTED FOR A HUMAN TO CHECK. The page itself never
 * joins on a name: rows key on fin_venues.id. This file is the one place a typed sheet name meets a
 * venue, which is why every pairing is listed in the dry run before anything is written.
 *
 * WHAT THE SHEET'S TWO HALVES DISAGREE ABOUT, resolved rather than announced:
 *   · KISC is Katy International Sports Complex, which is already a row — my own shorthand, not an
 *     orphan.
 *   · The five cities with actions and no goal row (San Antonio, St. Louis, Oklahoma, Austin,
 *     El Paso) become new-field slots. A city being worked with no goal is a row, not a warning.
 */
import { createClient } from "@supabase/supabase-js";

process.loadEnvFile(".env.local");
const APPLY = process.argv.includes("--apply");
const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const DEC = "2026-12-01";

/** The sheet: December goal per field, and the actions typed against it. */
const SHEET: { name: string; dec: number | null; actions: string[] }[] = [
  { name: "LBJ High School", dec: 2.0, actions: ["Solve light situation so we can expand to multiple days"] },
  { name: "STAR Soccer Complex", dec: 0.9, actions: ["Test 8:30 time + VEO GO to get to ideal numbers"] },
  { name: "Westlake High School", dec: 1.0, actions: [] },
  { name: "NEMP", dec: 3.0, actions: [] },
  { name: "Zipp Family Park", dec: 1.0, actions: ["Mondays added to the slate and second hour on Thursdays"] },
  { name: "Lowel Strike Middle School", dec: 0.9, actions: [] },
  { name: "Katy International", dec: 0.6, actions: ["Potential of Saturday, Sunday and Monday at 8:30"] },
  { name: "Round Rock Multipurpose", dec: 0.5, actions: ["Try to lock 3 nights per week"] },
  { name: "PRUMC", dec: 1.0, actions: ["Need to adjust to 60 minute matches - light solution"] },
  { name: "ATH Katy", dec: 1.0, actions: ["Get all the days to tourneys"] },
  { name: "Crockett High School", dec: 0.5, actions: ["Cover Onion Creek loss + Get closer to 1,0 match per day"] },
  { name: "Lou Fusz", dec: 0.6, actions: [] },
  { name: "The Hattrick Tomball", dec: 0.5, actions: ["Ask for 3 days per week"] },
  { name: "Ann Richards High School", dec: 0.5, actions: ["See if we can add Fridays"] },
  { name: "Scissortail Park", dec: 1.0, actions: ["6 days per week in October"] },
  { name: "Parmer Stadium", dec: 1.5, actions: ["Surpass December Goal (5 days per week)"] },
  { name: "Centennial Commons", dec: 0.3, actions: ["Ask for as many days as possible during winter"] },
  { name: "Crossbar Rowlett", dec: 0.5, actions: ["Add Friday to the weekly slate - Starts next week"] },
  { name: "Stony Point High School", dec: 0.2, actions: [] },
  { name: "Keswick", dec: 0.4, actions: ["Secure matches 3 nights per week"] },
  { name: "ATH Pearland", dec: 2.4, actions: [] },
  { name: "Soccer Central", dec: 3.7, actions: [] },
  { name: "The Hattrick Leander", dec: 0.7, actions: [] },
  { name: "Onion Creek", dec: 0.0, actions: [] },
];

/** The new-field rows: a slot, its December goal where the sheet set one, and its actions. */
const SLOTS: { name: string; dec: number | null; actions: string[] }[] = [
  { name: "New Field - Houston", dec: 1.0, actions: ["Field # 5 needs to be active in October - ATH Cypress / Woodlands / HSP"] },
  { name: "New Field - San Diego", dec: 1.0, actions: ["WMCA / PB Rec Center as potential leads - School District $300 arrangement"] },
  { name: "New Field - Atlanta", dec: 0.5, actions: ["New field needs to start at the beginning of October"] },
  { name: "New Field - Dallas", dec: 0.5, actions: ["Bob Jones", "JJ Pierce", "Polytechnic", "Crossbar Denton"] },
  { name: "New Field - Philadelphia", dec: 0.5, actions: ["Waiting for lights to start"] },
  // THE FIVE CITIES THE SHEET WORKS WITH NO GOAL ROW. They get a row and no target: an absent
  // target is an absent target, and the page shows it as "no goal" rather than inventing a zero.
  { name: "New Field - San Antonio", dec: null, actions: ["Wheatley starting late September"] },
  { name: "New Field - St. Louis", dec: null, actions: ["Potential test for the launch coordinator / Follow up with Ritter again"] },
  { name: "New Field - Oklahoma", dec: null, actions: ["Southlakes as potential field # 2 in OKC"] },
  { name: "New Field - Austin", dec: null, actions: ["Keep pushing the AISD conversation for more fields"] },
  { name: "New Field - El Paso", dec: null, actions: ["Potential to test Abra & De during weekends to find fields"] },
];

/* THE SHEET'S SHORTHAND, resolved by hand where a machine would guess. Every entry here is a name
 * the sheet uses that is not the venue's own name; anything not listed matches on its own. */
const ALIAS: Record<string, string> = {
  "LBJ High School": "LBJ Early College High School",
  "Lowel Strike Middle School": "Lowell H. Strike M.S.",
  "Katy International": "KISC (Katy Intl)",
  "Round Rock Multipurpose": "Round Rock",
  "Parmer Stadium": "PARMER Stadium",
  "Zipp Family Park": "New Braunfels",       // fin_venue 'New Braunfels' is field 1618, Zipp Family Sports Park
  "The Hattrick Tomball": "Hattrick T.",
  "The Hattrick Leander": "Hattrick",
  "Lou Fusz": "Lou Fusz Outdoor",
  "STAR Soccer Complex": "STAR",
  "Keswick": "Keswick Park",
  "Westlake High School": "Westlake",
  "Ann Richards High School": "Ann Richards School",
  "Stony Point High School": "Stony Point",
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

async function main() {
  const { data: venues } = await svc.from("fin_venues").select("id, venue_name, city");
  const byNorm = new Map((venues ?? []).map((v) => [norm(v.venue_name ?? ""), v]));
  const mapped: { sheet: string; venue: string; venueId: number; dec: number | null; actions: number }[] = [];
  const unplaced: string[] = [];

  for (const row of SHEET) {
    const target = ALIAS[row.name] ?? row.name;
    const v = byNorm.get(norm(target))
      ?? (venues ?? []).find((x) => norm(x.venue_name ?? "").includes(norm(target)) || norm(target).includes(norm(x.venue_name ?? "")));
    if (!v) { unplaced.push(row.name); continue; }
    mapped.push({ sheet: row.name, venue: v.venue_name as string, venueId: v.id as number, dec: row.dec, actions: row.actions.length });
  }

  console.log(`── EXISTING FIELDS: ${mapped.length} of ${SHEET.length} mapped to a venue by id ──`);
  for (const m of mapped) console.log(`  ${m.sheet.padEnd(28)} → venue ${String(m.venueId).padEnd(4)} ${m.venue.padEnd(28)} Dec ${m.dec}  ${m.actions} action(s)`);
  if (unplaced.length) console.log(`\n  UNPLACED (reported, never invented): ${JSON.stringify(unplaced)}`);
  console.log(`\n── NEW FIELD SLOTS: ${SLOTS.length} ──`);
  for (const s of SLOTS) console.log(`  ${s.name.padEnd(28)} Dec ${s.dec == null ? "— (no goal)" : s.dec}  ${s.actions.length} action(s)`);
  const totalActions = SHEET.reduce((n, r) => n + r.actions.length, 0) + SLOTS.reduce((n, s) => n + s.actions.length, 0);
  console.log(`\ntotal actions to write: ${totalActions}`);

  if (!APPLY) { console.log("\nDRY RUN — nothing written. Re-run with --apply."); return; }
  if (unplaced.length) { console.log("\nREFUSING TO WRITE: something did not map. Fix the alias table first."); process.exit(1); }

  for (const m of mapped) {
    const src = SHEET.find((s) => s.name === m.sheet)!;
    /* LOOK UP, THEN INSERT. The venue index is PARTIAL (WHERE venue_id IS NOT NULL, because a slot
     * has no venue), and ON CONFLICT cannot target a partial index — PostgREST answers "no unique
     * or exclusion constraint matching". Re-running this script is still safe. */
    const { data: existing } = await svc.from("field_goal_rows").select("id").eq("venue_id", m.venueId).maybeSingle();
    let rowId = existing?.id as string | undefined;
    if (!rowId) {
      const { data: row, error } = await svc.from("field_goal_rows").insert({ venue_id: m.venueId }).select("id").single();
      if (error) throw new Error(`${m.sheet}: ${error.message}`);
      rowId = row!.id as string;
    }
    if (src.dec != null) {
      const { error: te } = await svc.from("field_goal_targets")
        .upsert({ row_id: rowId, month: DEC, goal_daily: src.dec }, { onConflict: "row_id,month" });
      if (te) throw new Error(`${m.sheet} target: ${te.message}`);
    }
    for (const [i, text] of src.actions.entries()) {
      const { error: ae } = await svc.from("field_goal_actions").insert({ row_id: rowId, text, sort_order: i + 1 });
      if (ae) throw new Error(`${m.sheet} action: ${ae.message}`);
    }
  }
  for (const [i, s] of SLOTS.entries()) {
    const { data: row, error } = await svc.from("field_goal_rows")
      .insert({ slot_name: s.name, sort_order: i + 1 }).select("id").single();
    if (error) throw new Error(`${s.name}: ${error.message}`);
    const rowId = row!.id as string;
    if (s.dec != null) {
      const { error: te } = await svc.from("field_goal_targets").insert({ row_id: rowId, month: DEC, goal_daily: s.dec });
      if (te) throw new Error(`${s.name} target: ${te.message}`);
    }
    for (const [j, text] of s.actions.entries()) {
      const { error: ae } = await svc.from("field_goal_actions").insert({ row_id: rowId, text, sort_order: j + 1 });
      if (ae) throw new Error(`${s.name} action: ${ae.message}`);
    }
  }
  const counts = await Promise.all(["field_goal_rows", "field_goal_targets", "field_goal_actions"].map(async (t) => {
    const { count } = await svc.from(t).select("*", { count: "exact", head: true });
    return `${t} ${count}`;
  }));
  console.log(`\nWRITTEN · ${counts.join(" · ")}`);
}
await main();

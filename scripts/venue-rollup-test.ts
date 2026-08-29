/* A VENUE'S TOTALS ARE ITS FIELDS' TOTALS, ADDED UP.
 *
 * The Venues & Fields page reads venue-first: one collapsed block per fin_venues row showing field
 * count, matches, cancelled, spots and revenue, opening to one row per MatchDay field id. Those
 * five venue numbers are not served — the page computes them, which is new. That makes them the
 * number most likely to drift: a filter applied to the field rows and not to the total, a sort that
 * drops a row, a rounding step in one place and not the other.
 *
 * SO THE ASSERTION IS THE ARITHMETIC ITSELF, and every count/absence check below carries a control
 * that proves it can fail — because "no breaks" and "nothing was checked" produce the same empty
 * array, and the empty array is the answer this suite is hoping for.
 *
 * THE GROUPING IS SAFE BY CONSTRAINT: fin_venue_fields.mdapi_field_id is `bigint NOT NULL UNIQUE`
 * (migration 0041:36), so a field cannot sit under two venues and the nested shape is not lossy.
 * That is asserted here against the migration text, not against today's rows — data that happens
 * to have no duplicates is not the same claim as data that cannot.
 */

import { readFileSync } from "node:fs";
import { buildVenuesView, venueRollupBreaks, tagsFor } from "../src/lib/venuesModel";
import { isExcludedLink, includedLinks, excludedLinks } from "../src/lib/venueLinkFilter";
import type { FieldIdRow, VenueOption } from "../src/lib/fieldIdAdmin";

let pass = 0; const fails: string[] = [];
const ok = (m: string) => { pass++; console.log(`  ✓ ${m}`); };
const bad = (m: string, d = "") => { fails.push(`${m}${d ? ` — ${d}` : ""}`); console.log(`  ✗ ${m}${d ? ` — ${d}` : ""}`); };
const is = (m: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const field = (o: Partial<FieldIdRow> & { fieldId: number }): FieldIdRow => ({
  fieldId: o.fieldId, title: o.title ?? `field ${o.fieldId}`, titleVariants: o.titleVariants ?? 1,
  city: o.city ?? "Austin", address: o.address ?? "somewhere", zip: null,
  liveMatches: o.liveMatches ?? 0, cancelledMatches: o.cancelledMatches ?? 0, upcomingMatches: o.upcomingMatches ?? 0,
  firstMatch: o.firstMatch ?? null, lastMatch: o.lastMatch ?? null,
  dppRevenue: o.dppRevenue ?? 0, dppSpots: o.dppSpots ?? 0,
  billableLive: o.billableLive ?? (o.liveMatches ?? 0), billableCancelled: 0,
  billableSlotsLive: 0, billableSlotsWithCancelled: 0, allSlotsLive: 0, allSlotsWithCancelled: 0,
  sundayLive: 0, distinctLiveDays: 0, distinctLiveWeeks: 0,
  mapping: o.mapping ?? null,
} as FieldIdRow);

const link = (venueId: number, venueName: string, counts = false) =>
  ({ venueId, venueName, venueCity: "Austin", venueIsActive: true, countsAsRegularPlay: counts,
     excludedFromVenue: false, titleAtLink: null });

const venue = (o: Partial<VenueOption> & { id: number; venueName: string }): VenueOption => ({
  id: o.id, venueName: o.venueName, city: o.city ?? "Austin", isActive: o.isActive ?? true,
  billingType: "per_match",
  perMatchRate: o.perMatchRate === undefined ? 100 : o.perMatchRate,
  costPerMatch: o.costPerMatch === undefined ? 100 : o.costPerMatch,
  chargeOnCancel: false, billsPerReservation: false,
  fieldCount: 0, liveMatches: 0, dppRevenue: 0, split: null,
} as VenueOption);

console.log("\na venue's five totals ARE its fields', added up");
{
  const fields = [
    field({ fieldId: 10, liveMatches: 681, cancelledMatches: 159, dppSpots: 7506, dppRevenue: 70019.25, mapping: link(2, "NEMP") }),
    field({ fieldId: 17, liveMatches: 456, cancelledMatches: 19, dppSpots: 9122, dppRevenue: 91112.75, mapping: link(2, "NEMP") }),
    field({ fieldId: 99, liveMatches: 5, cancelledMatches: 1, dppSpots: 40, dppRevenue: 400 }), // unmapped
  ];
  const v = buildVenuesView(fields, [venue({ id: 2, venueName: "NEMP" })]);
  const nemp = v.venues[0];
  is("field count is the number of field rows", nemp.fieldCount, 2);
  is("matches add up", nemp.liveMatches, 681 + 456);
  is("cancelled adds up", nemp.cancelledMatches, 159 + 19);
  is("spots add up", nemp.spots, 7506 + 9122);
  is("revenue adds up, to the cent", Math.round(nemp.revenue * 100), Math.round((70019.25 + 91112.75) * 100));
  is("and the unmapped field is NOT in the venue's numbers", nemp.fields.map((f) => f.fieldId), [17, 10]);

  is("the checker finds no break", venueRollupBreaks(v.venues), []);
  /* THE CONTROL. An empty array is the passing value, and an empty INPUT returns the same empty
   * array — so the check above proves nothing until the checker is shown to fire. Break one total
   * by hand and it must name the venue and the column. */
  const broken = [{ ...nemp, spots: nemp.spots + 1 }];
  const b = venueRollupBreaks(broken);
  is("control: a doctored total IS caught", b.length, 1);
  is("…and it names the venue and the column", [b[0]?.name, b[0]?.column, b[0]?.venueTotal, b[0]?.fieldSum],
    ["NEMP", "spots", 16629, 16628]);
  // CONTROL 2: every column is actually checked, not just the first one that happens to differ.
  const allWrong = [{ ...nemp, fieldCount: 9, liveMatches: 1, cancelledMatches: 2, spots: 3, revenue: 4 }];
  is("control: all five columns are checked", venueRollupBreaks(allWrong).map((x) => x.column),
    ["fieldCount", "liveMatches", "cancelledMatches", "spots", "revenue"]);
  // CONTROL 3: an EMPTY venue list returns [] too — which is why the page states its denominator.
  is("control: an empty list also returns [], which is why the banner states the count", venueRollupBreaks([]), []);
}

console.log("\nan EXCLUDED field stays on its venue and out of its numbers");
{
  const on = (id: number, vid: number, name: string, excl: boolean, m: number, sp: number, rev: number) =>
    field({ fieldId: id, liveMatches: m, cancelledMatches: 2, dppSpots: sp, dppRevenue: rev,
      mapping: { ...link(vid, name), excludedFromVenue: excl } });
  const v = buildVenuesView(
    [on(199, 11, "Soccer Central", false, 423, 8461, 83742),
     on(102, 11, "Soccer Central", false, 392, 4158, 34902),
     on(1123, 11, "Soccer Central", true, 33, 0, 0)],
    [venue({ id: 11, venueName: "Soccer Central" })]);
  const sc = v.venues[0];

  /* THE POINT OF THE WHOLE FEATURE: 1123 is still on Soccer Central, still rendered, and out of
   * every one of the five totals. */
  is("the excluded field is still in the venue's field list",
    sc.fields.map((f) => f.fieldId).sort((a, b) => a - b), [102, 199, 1123]);
  is("…and is marked as excluded", sc.fields.find((f) => f.fieldId === 1123)?.excluded, true);
  is("…and the counted field count leaves it out", sc.fieldCount, 2);
  is("…and matches leave it out", sc.liveMatches, 423 + 392);
  is("…and spots leave it out", sc.spots, 8461 + 4158);
  is("…and revenue leaves it out", Math.round(sc.revenue), 83742 + 34902);
  is("…and cancelled leaves it out", sc.cancelledMatches, 4);
  is("what it is keeping out is reported, not silently dropped",
    [sc.excludedCount, sc.excludedMatches, sc.excludedSpots, sc.excludedRevenue], [1, 33, 0, 0]);

  /* CONTROL: the exclusion is DOING something. The same three fields with the flag off give the
   * full totals — so the numbers above are not just what this fixture always produces. */
  const all = buildVenuesView(
    [on(199, 11, "Soccer Central", false, 423, 8461, 83742),
     on(102, 11, "Soccer Central", false, 392, 4158, 34902),
     on(1123, 11, "Soccer Central", false, 33, 0, 0)],
    [venue({ id: 11, venueName: "Soccer Central" })]).venues[0];
  is("control: with the flag OFF the same fields give 3 and 848", [all.fieldCount, all.liveMatches], [3, 423 + 392 + 33]);
  is("control: …and nothing is reported as excluded", all.excludedCount, 0);
  /* CONTROL: a field whose exclusion costs REAL money moves the total by that money — the $0 case
   * above would pass a broken implementation that only ever subtracted zero. */
  const costly = buildVenuesView(
    [on(199, 11, "Soccer Central", true, 423, 8461, 83742),
     on(102, 11, "Soccer Central", false, 392, 4158, 34902)],
    [venue({ id: 11, venueName: "Soccer Central" })]).venues[0];
  is("control: excluding the $83,742 field moves revenue by $83,742", Math.round(costly.revenue), 34902);
  is("control: …and says so", Math.round(costly.excludedRevenue), 83742);

  // THE ROLLUP SUMS INCLUDED FIELDS ONLY, which is the claim the page prints.
  is("the rollup reconciles with an exclusion in place", venueRollupBreaks(v.venues), []);
  /* CONTROL: and it CATCHES a total that went back to counting everything — the exact regression
   * this whole section exists for. */
  const regressed = [{ ...sc, liveMatches: 423 + 392 + 33, fieldCount: 3 }];
  is("control: a total that counts the excluded field again is caught",
    venueRollupBreaks(regressed).map((b) => b.column).sort(), ["fieldCount", "liveMatches"]);

  /* AN UNMAPPED FIELD CANNOT BE EXCLUDED — the flag lives on the link, so there is nowhere to
   * hold it. Asserted so the unattributed block's zeros are structural, not incidental. */
  const loose = buildVenuesView([field({ fieldId: 14, liveMatches: 141, dppRevenue: 5503 })], []);
  is("an unattributed field is never excluded", loose.unattributed.fields[0]?.excluded, false);
  is("…and the block reports zero exclusions", loose.unattributed.excludedCount, 0);
}

console.log("\nthe exclude flag is read strictly, and every finance surface reads it");
{
  is("only a literal true excludes", [
    isExcludedLink({ excluded_from_venue: true }),
    isExcludedLink({ excluded_from_venue: false }),
    isExcludedLink({ excluded_from_venue: null }),
    isExcludedLink({}),                                 // the column does not exist yet
    isExcludedLink({ excluded_from_venue: "true" }),    // a string is not a yes
    isExcludedLink({ excluded_from_venue: 1 }),
    isExcludedLink(null),
  ], [true, false, false, false, false, false, false]);
  is("includedLinks keeps the counted ones",
    includedLinks([{ mdapi_field_id: 1 }, { mdapi_field_id: 2, excluded_from_venue: true }]).map((r) => r.mdapi_field_id), [1]);
  is("…and excludedLinks is its complement",
    excludedLinks([{ mdapi_field_id: 1 }, { mdapi_field_id: 2, excluded_from_venue: true }]).map((r) => r.mdapi_field_id), [2]);

  /* THE FILTER IS APPLIED WHERE THE FIELD->VENUE MAP IS BUILT, not per surface. Filtering later,
   * once per page, is how one page ends up disagreeing with another by exactly one field. */
  const strip = (x: string) => x.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const fin = strip(readFileSync("src/lib/useFinanceData.ts", "utf8"));
  if (/import \{ includedLinks \} from ".\/venueLinkFilter"/.test(fin)) ok("control: useFinanceData was read and imports the filter");
  else bad("control: useFinanceData imports the filter", "THE CHECKS BELOW WOULD PASS ON AN EMPTY STRING");
  if (/for \(const f of includedLinks\(vfRows\)\)/.test(fin)) ok("the field->venue map is built from INCLUDED links only");
  else bad("the field->venue map is built from included links only", "EXCLUDED FIELDS WOULD STILL COUNT ON COST AND FIELD ECONOMICS");
  /* SELECT * , NOT A COLUMN LIST. Code deploys before migrations apply; naming a column that does
   * not exist yet 400s the entire finance load, not just this table. */
  if (!/select\("fin_venue_id, mdapi_field_id, field_title_at_link, counts_as_regular_play"\)/.test(fin))
    ok("…and it selects * so a pre-migration deploy does not 400");
  else bad("useFinanceData still names columns", "0155 WOULD 400 THE WHOLE FINANCE LOAD BEFORE IT APPLIES");

  const mem = strip(readFileSync("src/app/api/membership/route.ts", "utf8"));
  if (/includedLinks\(linksRes\.data\)/.test(mem)) ok("the membership venue filter reads included links only");
  else bad("the membership venue filter reads included links only");

  const srv = strip(readFileSync("src/lib/fieldIdAdminServer.ts", "utf8"));
  if (/excludedFromVenue: isExcludedLink\(l\)/.test(srv)) ok("the page's own payload carries the flag");
  else bad("the page's own payload carries the flag");
}

console.log("\nthe unattributed block is the fields with no venue, and only those");
{
  const fields = [
    field({ fieldId: 14, liveMatches: 141, cancelledMatches: 54, dppSpots: 875, dppRevenue: 5503, upcomingMatches: 0 }),
    field({ fieldId: 1717, liveMatches: 12, upcomingMatches: 12, dppRevenue: 0 }),
    field({ fieldId: 10, liveMatches: 681, dppRevenue: 70019, mapping: link(2, "NEMP") }),
  ];
  const v = buildVenuesView(fields, [venue({ id: 2, venueName: "NEMP" })]);
  is("two fields are unattributed", v.unattributed.fieldCount, 2);
  is("…and the mapped one is not among them", v.unattributed.fields.map((f) => f.fieldId), [14, 1717]);
  is("its totals are those fields' totals", [v.unattributed.liveMatches, v.unattributed.spots, v.unattributed.revenue],
    [153, 875, 5503]);
  /* THE ONE THAT IS STILL GENERATING. 1717 Keswick Park has upcoming matches and no venue, so it
   * is not a historical gap — it is about to make more. The page names it separately. */
  is("a field with matches still to come is called out", v.unattributed.upcoming.map((x) => x.fieldId), [1717]);
  // CONTROL: the upcoming filter is not "everything" — 14 has 0 upcoming and must be excluded.
  is("control: a field with no upcoming matches is not called out",
    v.unattributed.upcoming.some((x) => x.fieldId === 14), false);
}

console.log("\nthe two warning classes say different things, and neither is a hardcoded list");
{
  const f = (id: number, vid: number, name: string) => field({ fieldId: id, liveMatches: 10, dppRevenue: 100, mapping: link(vid, name) });
  const view = buildVenuesView(
    [f(1, 63, "PARMER"), f(2, 8, "ATH Pearland"), f(3, 1, "San Juan Diego"), f(4, 3, "Hattrick")],
    [
      venue({ id: 63, venueName: "PARMER", perMatchRate: null, costPerMatch: null }),   // both null
      venue({ id: 8, venueName: "ATH Pearland", perMatchRate: 160, costPerMatch: 160 }), // agrees
      venue({ id: 1, venueName: "San Juan Diego", perMatchRate: null, costPerMatch: 40 }), // null one side
      venue({ id: 3, venueName: "Hattrick", perMatchRate: null, costPerMatch: 32 }),
      venue({ id: 23, venueName: "ATH Katy Sunday", perMatchRate: 160, costPerMatch: null }), // NO FIELDS
    ],
  );
  is("a venue with either rate column null and a field on it is warned",
    view.rateless.map((v) => v.venueId).sort((a, b) => a - b), [1, 3, 63]);
  /* A VENUE WITH NO FIELDS IS IN NEITHER CLASS. Nothing is attributed to #23, so nothing of its is
   * being billed at zero — the harm the amber class names requires a field. */
  is("…but a venue with NO fields is not, even with a null column", view.rateless.some((v) => v.venueId === 23), false);
  // CONTROL: the class is not "every venue" — the one with a real rate on both columns is out.
  is("control: a venue with both rates set is not warned", view.rateless.some((v) => v.venueId === 8), false);

  /* DISAGREEMENT IS ABOUT THE ROW, not about whether a field hangs off it, so #23 IS flagged. */
  is("every row whose two rate columns disagree is flagged, fields or not",
    view.disagreements.map((v) => v.venueId).sort((a, b) => a - b), [1, 3, 23]);
  is("…and null-vs-null is not a disagreement", view.disagreements.some((v) => v.venueId === 63), false);
  is("control: equal rates are not a disagreement", view.disagreements.some((v) => v.venueId === 8), false);
  is("the rate the page shows is cost_per_match", view.venues.find((v) => v.venueId === 1)?.rate, 40);
  is("…and per_match_rate is kept so a disagreement can show both", view.venues.find((v) => v.venueId === 1)?.altRate, null);
}

console.log("\nevery tag is derived, and there is no venue-level 2-pitches tag");
{
  is("counts as 2 comes from the LINK's counts_as_regular_play",
    tagsFor(field({ fieldId: 496, mapping: link(18, "Lou Fusz Outdoor", true) })), ["counts as 2"]);
  is("renamed comes from titleVariants > 1", tagsFor(field({ fieldId: 1024, titleVariants: 2 })), ["renamed"]);
  is("special event comes from live > billable",
    tagsFor(field({ fieldId: 1123, liveMatches: 33, billableLive: 0 })), ["special event"]);
  is("a plain field carries none", tagsFor(field({ fieldId: 27, liveMatches: 197, billableLive: 197 })), []);
  is("and they stack", tagsFor(field({ fieldId: 22, titleVariants: 3, liveMatches: 559, billableLive: 0, mapping: link(8, "ATH Pearland", true) })),
    ["counts as 2", "renamed", "special event"]);
  /* AN UNMAPPED FIELD CANNOT CARRY "counts as 2" — the flag lives on the link, so a field with no
   * link has nowhere to hold it. Asserted because the obvious refactor is to read it off the field. */
  is("an unmapped field cannot be counts-as-2", tagsFor(field({ fieldId: 21, liveMatches: 43, billableLive: 43 })), []);

  /* THE WITHDRAWN TAG. "2 pitches" was invented and neither derivation was right: counting fields
   * does not mean two pitches side by side, and re-stating a field-level flag on the venue says it
   * in the wrong place. There is no column for it and nothing here may fake one. */
  const model = readFileSync("src/lib/venuesModel.ts", "utf8");
  const view = readFileSync("src/components/VenuesFieldsView.tsx", "utf8");
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  if (/export function buildVenuesView/.test(strip(model))) ok("control: the model was read");
  else bad("control: the model was read", "THE ABSENCE CHECKS BELOW WOULD PASS ON AN EMPTY STRING");
  if (/VenuesFieldsView/.test(strip(view))) ok("control: the view was read");
  else bad("control: the view was read");
  if (!/2 pitches|twopitch|twoPitch/i.test(strip(model) + strip(view))) ok("no 2-pitches tag survives in code");
  else bad("a 2-pitches tag is still rendered", "IT HAS NO COLUMN BEHIND IT");
}

console.log("\nthe grouping is safe by CONSTRAINT, not by today's rows");
{
  const mig = readFileSync("supabase/migrations/0041_fin_venue_fields.sql", "utf8");
  if (/mdapi_field_id\s+bigint\s+NOT NULL UNIQUE/i.test(mig)) ok("mdapi_field_id is UNIQUE in the schema");
  else bad("mdapi_field_id is UNIQUE in the schema", "A FIELD COULD SIT UNDER TWO VENUES AND THE NESTED LIST WOULD LOSE ONE");
  // CONTROL: the file was actually read and holds the table.
  if (/CREATE TABLE IF NOT EXISTS fin_venue_fields/.test(mig)) ok("control: the migration was read");
  else bad("control: the migration was read");
}

console.log("\nthe UI adds nothing to the write path");
{
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const view = strip(readFileSync("src/components/VenuesFieldsView.tsx", "utf8"));
  if (/fetch\("\/api\/admin\/fields\/assign"/.test(view)) ok("it posts to the route that already exists");
  else bad("it posts to /api/admin/fields/assign", "A SECOND WRITE PATH");
  /* NO WRITE THAT IS NOT ONE OF THE TWO GUARDED ROUTES.
   *
   * THIS ASSERTION WAS `posts.length === 1` AND IS NOW A WHITELIST — itemised because it is a
   * loosened check. The count stood in for the real rule ("no path that bypasses recordWrite"),
   * and it broke the moment a second legitimate guarded route was added. Counting would have to
   * be relaxed again for the third; naming the endpoints does not, and it still fails on exactly
   * what the count was protecting: a fetch to anywhere else, or a Supabase write. */
  const ALLOWED_WRITE_URLS = ["/api/admin/fields/assign", "/api/admin/fields/exclude"];
  const writeFetches = [...view.matchAll(/fetch\(\s*"([^"]+)"[\s\S]{0,200}?method:\s*"(POST|PUT|PATCH|DELETE)"/g)]
    .map((m2) => m2[1]);
  is("every non-GET goes to a guarded route, and only those",
    writeFetches.filter((u) => !ALLOWED_WRITE_URLS.includes(u)), []);
  // CONTROL: the scan finds writes at all — an empty result satisfies the line above for free.
  is("control: the write scan is not empty", writeFetches.length, 2);
  is("control: …and it found both of them", [...writeFetches].sort(), [...ALLOWED_WRITE_URLS].sort());
  if (!/supabase\.from\(/.test(view)) ok("…and the view never writes Supabase directly");
  else bad("the view touches Supabase directly", "THAT PATH HAS NO VERDICT AND NO CHANGE LOG");

  /* counts_as_regular_play IS NOT ON THE FORM and is always sent false. That flag doubles a
   * venue's cost basis; on the form used to clear 36 unmapped fields it is one stray click. */
  if (/countsAsRegularPlay: false/.test(view)) ok("counts_as_regular_play is always sent false");
  else bad("counts_as_regular_play is always sent false", "IT BECAME A CONTROL ON THE BULK FORM");
  if (!/countsAsRegularPlay: (true|counts|checked)/.test(view)) ok("…and nothing on the form can set it true");
  else bad("something on the form can set counts_as_regular_play true");

  /* THE VERDICT IS THE ROUTE'S, and a non-LANDED outcome must not read as success. */
  if (/outcome === "LANDED"/.test(view)) ok("the row reports the route's outcome, not the status code");
  else bad("the row reports the route's outcome", "A 2XX IS NOT PROOF THE LINK LANDED");
  if (/logRecorded === false \|\| j\.finLogRecorded === false/.test(view)) ok("…and a logging hole is said out loud");
  else bad("…and a logging hole is said out loud", "BOTH LOGS ARE LOAD-BEARING");
  if (/busy \|\| !choice/.test(view)) ok("Assign is disabled until a venue is chosen, and while in flight");
  else bad("Assign is disabled until a venue is chosen");
  if (/creating \? "Create & assign"/.test(view)) ok("choosing create changes the button, so it cannot happen by accident");
  else bad("choosing create changes the button");
}

console.log(`\nvenue-rollup: ${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log(`  FAILED: ${f}`); process.exit(1); }

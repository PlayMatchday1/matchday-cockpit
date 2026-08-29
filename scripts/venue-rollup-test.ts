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
  ({ venueId, venueName, venueCity: "Austin", venueIsActive: true, countsAsRegularPlay: counts, titleAtLink: null });

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
  /* NO SECOND WRITE. The only non-GET this file may make is that one POST. Any other insert,
   * update or Supabase write here would bypass recordWrite's verdict and fin_change_log entirely. */
  const posts = view.match(/method:\s*"(POST|PUT|PATCH|DELETE)"/g) ?? [];
  is("…and it is the ONLY non-GET the view makes", posts.length, 1);
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

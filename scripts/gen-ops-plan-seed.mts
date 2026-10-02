/* GENERATES supabase/migrations/0200_ops_plan_2027_seed.sql — READ ONLY against the database.
 *
 *   npx tsx scripts/gen-ops-plan-seed.mts
 *
 * The forecast's numbers are typed below from MatchDay Forecast, Sep 2026 (Ryan's spec, 2026-10-02)
 * and the 2027 opening schedule from docs/mocks/2027-operations-plan-mock.html. Everything about
 * EXISTING fields comes from the Clubhouse's own records at generation time: which venues are live
 * (a counted match played in the trailing 30 completed days), which are anchors (at or above 670
 * spots in that window), and the 2026 page's slots. It writes nothing to the database; the SQL it
 * emits is applied by hand, after the code that filters 2027 rows off the 2026 page has deployed.
 *
 * THE RULES, all Ryan's, 2026-10-02:
 *   · existing cities: each planned 2027 field carries its ramp (lib/opsPlan.rampAt with the city's
 *     mature rate); one "Existing fields (forecast base)" row carries the city's spots minus those
 *     ramps. Negative remainders are listed, not clamped.
 *   · launch cities: no base row; each month's spots are split across the open planned fields in
 *     proportion to their ramp, at a tenth, leftover to the earliest-opened field.
 *   · anchor slots: a city's slots, minus live fields at or above the threshold, minus the 2026
 *     slots (which take slots first); the first 2027 openings take what is left.
 *   · the 10 not-counted rows stay out; the 2026 slots in plan cities go in as planned, no month.
 */
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { selectAll } from "@/lib/supabasePagination";
import { businessYesterday, countsTowardGoals, playedByYesterday, MONTH_LABELS } from "@/lib/fieldGoals";
import { DEFAULT_ANCHOR_THRESHOLD, PLAN_YEAR, TRAILING_DAYS, planMonthKeys, normAlias } from "@/lib/opsPlan";

const env = Object.fromEntries(fs.readFileSync(".env.local", "utf8").split("\n")
  .filter((l) => /^[A-Z_]+=/.test(l)).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, "")]; }));
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

import { FORECAST_CITIES as CITIES, FORECAST_HIRES as HIRES, FORECAST_REGIONS as REGIONS, HEADLINE, seedEstimates } from "@/lib/opsPlanForecast";

// ── the Clubhouse's own records ─────────────────────────────────────────────────────────────
const now = new Date();
const yesterday = businessYesterday(now);
const [yy, ym, yd] = yesterday.split("-").map(Number);
const ws = new Date(Date.UTC(yy, ym - 1, yd - (TRAILING_DAYS - 1)));
const windowStart = ws.toISOString().slice(0, 10);

type M = { field_id: number | null; field_title: string | null; city_identifier: string | null; start_date: string; player_count: number | null; is_cancelled: boolean | null };
const matches = (await selectAll<M>(() => sb.from("mdapi_matches")
  .select("field_id, field_title, city_identifier, start_date, player_count, is_cancelled")
  .gte("start_date", `${windowStart}T00:00:00`).lte("start_date", `${yesterday}T23:59:59`)
  .is("deleted_at", null).order("api_id") as never)).filter(countsTowardGoals)
  .filter((m) => String(m.start_date).slice(0, 10) >= windowStart && playedByYesterday(m.start_date, yesterday));
const { data: links } = await sb.from("fin_venue_fields").select("fin_venue_id, mdapi_field_id");
const { data: venues } = await sb.from("fin_venues").select("id, venue_name, city");
const { data: rows, error: rowsErr } = await sb.from("field_goal_rows").select("*");
if (rowsErr || !rows || !links || !venues) throw new Error(`read failed: ${rowsErr?.message}`);
const venueOf = new Map(links.map((l) => [Number(l.mdapi_field_id), Number(l.fin_venue_id)]));
const venueById = new Map(venues.map((v) => [Number(v.id), v]));
const notCountedVenue = new Set(rows.filter((r) => r.not_counted === true && r.venue_id != null).map((r) => Number(r.venue_id)));
const notCountedField = new Set(rows.filter((r) => r.not_counted === true && r.field_id != null).map((r) => Number(r.field_id)));

// trailing 30 days per venue (or unmapped field)
type Live = { venueId: number | null; fieldId: number | null; name: string; cityAlias: string; idAlias: string | null; spots: number; matches: number };
const live = new Map<string, Live>();
for (const m of matches) {
  const fid = Number(m.field_id); const vid = venueOf.get(fid) ?? null;
  if (vid != null ? notCountedVenue.has(vid) : notCountedField.has(fid)) continue;
  const key = vid != null ? `v${vid}` : `f${fid}`;
  const l = live.get(key) ?? { venueId: vid, fieldId: vid == null ? fid : null,
    name: vid != null ? String(venueById.get(vid)?.venue_name) : String(m.field_title),
    cityAlias: vid != null ? String(venueById.get(vid)?.city ?? "") : "", idAlias: m.city_identifier, spots: 0, matches: 0 };
  l.spots += m.player_count ?? 0; l.matches += 1; live.set(key, l);
}
const cityOfLive = (l: Live) => CITIES.find((c) =>
  (l.venueId != null && c.venueAliases.some((a) => normAlias(a) === normAlias(l.cityAlias))) ||
  (l.venueId == null && c.cityIds.some((a) => normAlias(a) === normAlias(l.idAlias))));
const slots2026 = rows.filter((r) => r.slot_name != null && r.not_counted !== true && r.plan_year == null);
const cityOfSlot = (r: Record<string, unknown>) => CITIES.find((c) => c.venueAliases.some((a) => normAlias(a) === normAlias(r.city as string)));

// ── build ───────────────────────────────────────────────────────────────────────────────────
const THRESHOLD = DEFAULT_ANCHOR_THRESHOLD;
const KEYS = planMonthKeys(PLAN_YEAR);
const q = (s: string | null) => (s == null ? "NULL" : `'${s.replace(/'/g, "''")}'`);
const sql: string[] = [];
const summary: string[] = [];
const negatives: string[] = [];
const expected: Record<string, number[]> = {};
const counts = { regions: REGIONS.length, cities: CITIES.length, hires: HIRES.length, liveVenueRowsInserted: 0,
  planLive: 0, planSlots2026: 0, planNew2027: 0, planBase: 0, slotRows2027: 0, targets: 0 };
const unmatchedLive: string[] = [];
for (const l of live.values()) if (!cityOfLive(l)) unmatchedLive.push(`${l.name} (${l.cityAlias || l.idAlias})`);

for (const r of REGIONS) sql.push(`INSERT INTO public.plan_regions (key, name, short_name, note, sort_order) VALUES (${q(r.key)}, ${q(r.name)}, ${q(r.short)}, ${q(r.note)}, ${REGIONS.indexOf(r)});`);
HIRES.forEach((h, i) => sql.push(`INSERT INTO public.plan_hires (plan_year, hire_month, running_month, role, kind, region_key, sort_order) VALUES (${PLAN_YEAR}, ${q(h.hire)}, ${q(h.run)}, ${q(h.role)}, ${q(h.kind)}, ${q(h.region)}, ${i});`));

CITIES.forEach((c, ci) => {
  const cityId = randomUUID();
  const arr = (xs: string[]) => `ARRAY[${xs.map(q).join(", ")}]::text[]`;
  sql.push(`\n-- ${c.name}`);
  sql.push(`INSERT INTO public.plan_cities (id, plan_year, name, region_key, launch_month, anchor_slots, mature_spots_per_field, venue_city_aliases, city_identifiers, sort_order) VALUES (${q(cityId)}, ${PLAN_YEAR}, ${q(c.name)}, ${q(c.region)}, ${q(c.launch)}, ${c.slots}, ${c.mature}, ${arr(c.venueAliases)}, ${arr(c.cityIds)}, ${ci});`);

  // live venues: planned type is what they ARE today
  const liveHere = [...live.values()].filter((l) => cityOfLive(l) === c).sort((a, b) => b.spots - a.spots);
  const liveAnchors = liveHere.filter((l) => l.spots >= THRESHOLD).length;
  for (const l of liveHere) {
    const ident = l.venueId != null ? `venue_id = ${l.venueId}` : `field_id = ${l.fieldId}`;
    const col = l.venueId != null ? "venue_id" : "field_id"; const val = l.venueId ?? l.fieldId;
    if (!rows.some((r) => (l.venueId != null ? Number(r.venue_id) === l.venueId : Number(r.field_id) === l.fieldId))) counts.liveVenueRowsInserted++;
    sql.push(`INSERT INTO public.field_goal_rows (${col}, city) SELECT ${val}, ${q(l.cityAlias || l.idAlias)} WHERE NOT EXISTS (SELECT 1 FROM public.field_goal_rows WHERE ${ident});`);
    sql.push(`INSERT INTO public.field_goal_plan (row_id, plan_year, plan_city_id, role, status, planned_type) SELECT id, ${PLAN_YEAR}, ${q(cityId)}, 'field', 'live', ${q(l.spots >= THRESHOLD ? "anchor" : "satellite")} FROM public.field_goal_rows WHERE ${ident};   -- ${l.name}: ${l.matches} matches, ${l.spots} spots in trailing ${TRAILING_DAYS}d`);
    counts.planLive++;
  }

  // slots open after live anchors; the 2026 slots take them first, then 2027 openings in order
  let open = Math.max(0, c.slots - liveAnchors);
  const take = (): "anchor" | "satellite" => (open-- > 0 ? "anchor" : "satellite");
  const s26 = slots2026.filter((r) => cityOfSlot(r) === c);
  let a = 0, s = 0;
  for (const r of s26) {
    const t = take(); t === "anchor" ? a++ : s++;
    sql.push(`INSERT INTO public.field_goal_plan (row_id, plan_year, plan_city_id, role, status, planned_type) VALUES (${q(r.id as string)}, ${PLAN_YEAR}, ${q(cityId)}, 'field', 'planned', ${q(t)});   -- 2026 slot "${r.slot_name}"`);
    counts.planSlots2026++;
  }
  /* THE ESTIMATES ARE lib/opsPlanForecast.seedEstimates — the same function the guard asserts on.
   * Types are assigned here because they depend on the Clubhouse's live anchors. */
  const seeded = seedEstimates(c);
  type NewF = { id: string; open: string; type: "anchor" | "satellite" };
  const news: NewF[] = seeded.fields.map((sf) => { const t = take(); t === "anchor" ? a++ : s++; return { id: randomUUID(), open: sf.open, type: t }; });
  const est = new Map<string, (number | null)[]>(news.map((f, i) => [f.id, seeded.fields[i].est]));
  const isLaunch = c.launch != null;
  const baseId: string | null = seeded.base ? randomUUID() : null;
  const base: number[] = seeded.base ?? [];
  base.forEach((v, mi) => { if (v < 0) negatives.push(`${c.name} ${MONTH_LABELS[mi]} ${v}`); });

  news.forEach((f, k) => {
    sql.push(`INSERT INTO public.field_goal_rows (id, slot_name, city, plan_year, sort_order) VALUES (${q(f.id)}, ${q(`New field ${k + 1}`)}, ${q(c.name)}, ${PLAN_YEAR}, ${k + 1});`);
    sql.push(`INSERT INTO public.field_goal_plan (row_id, plan_year, plan_city_id, role, status, planned_type, planned_open_month) VALUES (${q(f.id)}, ${PLAN_YEAR}, ${q(cityId)}, 'field', 'planned', ${q(f.type)}, ${q(f.open)});`);
    const vals = est.get(f.id)!.map((v, mi) => (v == null || v === 0 ? null : `(${q(f.id)}, ${q(KEYS[mi])}, ${v})`)).filter(Boolean);
    if (vals.length) sql.push(`INSERT INTO public.field_goal_targets (row_id, month, goal_spots) VALUES ${vals.join(", ")};`);
    counts.targets += vals.length; counts.slotRows2027++; counts.planNew2027++;
  });
  if (baseId) {
    sql.push(`INSERT INTO public.field_goal_rows (id, slot_name, city, plan_year, sort_order) VALUES (${q(baseId)}, 'Existing fields (forecast base)', ${q(c.name)}, ${PLAN_YEAR}, 0);`);
    sql.push(`INSERT INTO public.field_goal_plan (row_id, plan_year, plan_city_id, role, status) VALUES (${q(baseId)}, ${PLAN_YEAR}, ${q(cityId)}, 'forecast_base', 'live');`);
    const vals = base.map((v, mi) => (c.spots[mi] === 0 ? null : `(${q(baseId)}, ${q(KEYS[mi])}, ${v})`)).filter(Boolean);
    sql.push(`INSERT INTO public.field_goal_targets (row_id, month, goal_spots) VALUES ${vals.join(", ")};`);
    counts.targets += vals.length; counts.slotRows2027++; counts.planBase++;
  }

  // what the rows sum to, per month, in tenths — must equal the forecast exactly
  expected[c.name] = KEYS.map((_, mi) => {
    const t = news.reduce((acc, f) => acc + Math.round((est.get(f.id)![mi] ?? 0) * 10), 0) + (baseId ? Math.round(base[mi] * 10) : 0);
    return t / 10;
  });
  const exact = expected[c.name].every((v, mi) => v === c.spots[mi]);
  summary.push(`${c.name.padEnd(28)} live ${String(liveHere.length).padStart(2)} (${liveAnchors} anchor)  2026 slots ${s26.length}  2027 new ${news.length}  → planned ${a}A/${s}S  ${isLaunch ? "launch" : "base row"}  ${exact ? "sums exactly" : "MISMATCH"}`);
});

// ── self-check, inside the transaction: the rows must sum to the forecast ────────────────────
const expRows = CITIES.map((c) => `(${q(c.name)}, ARRAY[${c.spots.join(",")}]::numeric[])`).join(",\n    ");
const check = `
-- ══ SELF-CHECK. Raises, and so rolls back the whole seed, if any city-month's rows do not sum to
-- the forecast exactly, or a month's total is more than 2 spots off the headline. ═════════════
DO $$
DECLARE r record; m integer; got numeric; tot numeric; headline numeric[] := ARRAY[${HEADLINE.join(",")}]::numeric[];
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ${expRows}) AS t(city, spots) LOOP
    FOR m IN 1..12 LOOP
      SELECT coalesce(sum(t.goal_spots), 0) INTO got
        FROM public.field_goal_targets t
        JOIN public.field_goal_plan p ON p.row_id = t.row_id AND p.plan_year = ${PLAN_YEAR} AND p.status <> 'removed'
        JOIN public.plan_cities c ON c.id = p.plan_city_id AND c.name = r.city AND c.plan_year = ${PLAN_YEAR}
       WHERE t.month = make_date(${PLAN_YEAR}, m, 1);
      IF got <> r.spots[m] THEN RAISE EXCEPTION 'seed check: % month % sums to %, forecast %', r.city, m, got, r.spots[m]; END IF;
    END LOOP;
  END LOOP;
  FOR m IN 1..12 LOOP
    SELECT coalesce(sum(goal_spots), 0) INTO tot FROM public.field_goal_targets WHERE month = make_date(${PLAN_YEAR}, m, 1) AND goal_spots IS NOT NULL;
    IF abs(tot - headline[m]) > 2 THEN RAISE EXCEPTION 'seed check: month % totals %, headline %', m, tot, headline[m]; END IF;
  END LOOP;
END $$;`;

const header = `-- 0200 — 2027 OPERATIONS PLAN: THE SEED. GENERATED by scripts/gen-ops-plan-seed.ts on ${now.toISOString()}.
-- Do not hand-edit; regenerate. Existing fields are as of the trailing ${TRAILING_DAYS} completed days ${windowStart} to ${yesterday}
-- (Chicago), threshold ${THRESHOLD} spots. Forecast figures: MatchDay Forecast, Sep 2026.
--
-- APPLY ONLY AFTER 0199 AND AFTER THE CODE THAT FILTERS 2027 ROWS OFF THE 2026 PAGE HAS DEPLOYED.
-- Refuses to run twice. Checks itself before committing (see the DO block at the end).
--
-- Inserts: ${counts.regions} regions, ${counts.cities} cities, ${counts.hires} hires; ${counts.slotRows2027} slot rows created for ${PLAN_YEAR}
-- (${counts.planNew2027} planned fields + ${counts.planBase} forecast-base rows); ${counts.liveVenueRowsInserted} venue rows that did not exist yet;
-- ${counts.planLive + counts.planSlots2026 + counts.planNew2027 + counts.planBase} field_goal_plan entries (${counts.planLive} live, ${counts.planSlots2026} existing 2026 slots, ${counts.planNew2027} new, ${counts.planBase} base);
-- ${counts.targets} field_goal_targets rows in goal_spots.
-- Apply in the Supabase SQL Editor. Not applied by the app.

begin;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.plan_cities WHERE plan_year = ${PLAN_YEAR}) THEN
    RAISE EXCEPTION 'the ${PLAN_YEAR} plan is already seeded';
  END IF;
END $$;
`;
fs.writeFileSync("supabase/migrations/0200_ops_plan_2027_seed.sql", `${header}\n${sql.join("\n")}\n${check}\n\ncommit;\n`);

// ── the report ──────────────────────────────────────────────────────────────────────────────
console.log(`window ${windowStart} → ${yesterday}, ${matches.length} played counted matches`);
console.log(JSON.stringify(counts));
console.log(summary.join("\n"));
console.log("live fields with no plan city:", unmatchedLive.length ? unmatchedLive.join("; ") : "none");
console.log("negative forecast-base remainders (existing cities):", negatives.length ? negatives.join("; ") : "none");
const tot = KEYS.map((_, mi) => CITIES.reduce((acc, c) => acc + Math.round(expected[c.name][mi] * 10), 0) / 10);
console.log("monthly totals:", tot.map((t, i) => `${MONTH_LABELS[i]} ${t} (headline ${HEADLINE[i]}, ${t - HEADLINE[i] >= 0 ? "+" : ""}${t - HEADLINE[i]})`).join(" · "));
const fieldsDec = counts.planLive + counts.planSlots2026 + counts.planNew2027;
console.log(`plan fields at start of 2027: ${counts.planLive + counts.planSlots2026} (forecast 39) · at Dec 2027: ${fieldsDec} (forecast 174) · opened in 2027: ${counts.planNew2027} (forecast 135)`);

/* SPOTS, WEEK AGAINST WEEK - where the movement came from, by city and by field.
 *
 * READ-ONLY. Nothing here writes, resyncs or touches a match.
 *
 *   npx tsx scripts/spots-week-compare.mts <fromA> <toA> <fromB> <toB>
 *   npx tsx scripts/spots-week-compare.mts 2026-07-27 2026-08-02 2026-08-31 2026-09-06
 *
 * "SPOTS" IS FOUR DIFFERENT NUMBERS in this codebase and they move for different reasons, so all
 * four deltas are reported and the answer names which one the question is about:
 *
 *   real       player_count - fake_player_count   real people who bought
 *   filled     player_count                       real + fake, every occupied seat
 *   capacity   max_player_count                   what was bookable - AND IT MOVES: the manual
 *              convert-to-4 path writes perTeam x 4, so a 22 becomes 44 when a match gets MORE
 *              popular, while MatchDay auto-bump does not move it at all. Reported, not led with.
 *   fieldSpots fin_venues.max_players, else max_player_count   what the field can hold
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
for (const l of readFileSync(".env.local", "utf8").split("\n")) {
  const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const { canonicalVenueName } = await import("../src/lib/venueResolver");
const { CITY_CODE_TO_DISPLAY } = await import("../src/lib/scheduleReconcile");

const [aF, aT, bF, bT] = process.argv.slice(2);
if (!aF || !aT || !bF || !bT) { console.log("usage: <fromA> <toA> <fromB> <toB>"); process.exit(1); }

let FAILED = 0;
const assert = (label: string, cond: boolean, detail = "") => {
  if (cond) console.log(`  OK  ${label}`);
  else { FAILED++; console.log(`  XX  ${label}${detail ? ` - ${detail}` : ""}`); }
};
const n = (x: unknown) => Number(x) || 0;
const pad = (s: unknown, w: number) => String(s).padEnd(w);
const num = (x: number, w = 7) => String(Math.round(x)).padStart(w);
const sgn = (x: number, w = 7) => `${x > 0 ? "+" : ""}${Math.round(x)}`.padStart(w);
const LINE = "".padEnd(96, "=");

const [{ data: vf }, { data: vs }] = await Promise.all([
  sb.from("fin_venue_fields").select("fin_venue_id, mdapi_field_id"),
  sb.from("fin_venues").select("id, max_players"),
]);
const maxByVenue = new Map((vs ?? []).filter((v: any) => v.max_players != null).map((v: any) => [v.id, Number(v.max_players)]));
const venueMax = new Map<number, number>();
for (const l of vf ?? []) { const m = maxByVenue.get((l as any).fin_venue_id); if (m != null && (l as any).mdapi_field_id != null) venueMax.set(Number((l as any).mdapi_field_id), m); }

type Row = { api_id: number; start_date: string; city_identifier: string | null; field_title: string | null;
  field_id: number | null; player_count: number | null; fake_player_count: number | null;
  max_player_count: number | null; is_cancelled: boolean | null; synced_at: string | null };

async function fetchWindow(from: string, to: string): Promise<Row[]> {
  const out: Row[] = [];
  for (let page = 0; ; page++) {
    const { data, error } = await sb.from("mdapi_matches")
      .select("api_id, start_date, city_identifier, field_title, field_id, player_count, fake_player_count, max_player_count, is_cancelled, deleted_at, synced_at")
      .gte("start_date", `${from}T00:00:00`).lte("start_date", `${to}T23:59:59`)
      .is("deleted_at", null)
      .order("start_date").range(page * 1000, page * 1000 + 999);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as unknown as Row[]));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

const real = (r: Row) => Math.max(0, n(r.player_count) - n(r.fake_player_count));
const fake = (r: Row) => n(r.fake_player_count);
const filled = (r: Row) => n(r.player_count);
const capacity = (r: Row) => n(r.max_player_count);
const fieldSpots = (r: Row) => {
  const cap = capacity(r); if (cap <= 0) return 0;
  const v = r.field_id != null ? venueMax.get(Number(r.field_id)) : undefined;
  return v != null && v > 0 ? Math.max(v, cap) : cap;
};

const cityOf = (r: Row) => {
  const code = (r.city_identifier ?? "").trim();
  if (!code) return "(no city_identifier)";
  /* NEVER `if (!city) continue`. That pattern dropped every Warsaw row twice; an unmapped code is
   * REPORTED under its raw value rather than eaten. */
  return CITY_CODE_TO_DISPLAY[code] ?? `${code}(UNMAPPED)`;
};
const fieldOf = (r: Row) => canonicalVenueName(r.field_title) || "(no field_title)";

type Agg = { matches: number; cancelled: number; real: number; fake: number; filled: number; capacity: number; fieldSpots: number };
const zero = (): Agg => ({ matches: 0, cancelled: 0, real: 0, fake: 0, filled: 0, capacity: 0, fieldSpots: 0 });
/* CANCELLED MATCHES ARE COUNTED SEPARATELY AND CONTRIBUTE NOTHING TO FILL. They occupied a slot on
 * the schedule but sold nothing, so folding them into the fill numbers would read a supply or
 * weather event as a demand drop. `matches` counts matches that RAN. */
function add(a: Agg, r: Row) {
  if (r.is_cancelled) { a.cancelled++; return; }
  a.matches++; a.real += real(r); a.fake += fake(r); a.filled += filled(r);
  a.capacity += capacity(r); a.fieldSpots += fieldSpots(r);
}
const rollup = (rows: Row[], key: (r: Row) => string) => {
  const m = new Map<string, Agg>();
  for (const r of rows) { const k = key(r); if (!m.has(k)) m.set(k, zero()); add(m.get(k)!, r); }
  return m;
};
const total = (rows: Row[]) => { const a = zero(); for (const r of rows) add(a, r); return a; };

async function compare(aFrom: string, aTo: string, bFrom: string, bTo: string, label = "") {
  const A = await fetchWindow(aFrom, aTo), B = await fetchWindow(bFrom, bTo);
  console.log(`\n${LINE}\n${label}A  ${aFrom} .. ${aTo}   (${A.length} matches)\n${label}B  ${bFrom} .. ${bTo}   (${B.length} matches)\n${LINE}`);
  if (!A.length || !B.length) { console.log("  one of the windows is empty - no comparison possible"); return { ok: false as const }; }

  console.log("\n-- synced_at coverage (a week that synced badly reads as a week that sold badly) --");
  for (const [nm, rows] of [["A", A], ["B", B]] as const) {
    const withSync = rows.filter((r) => r.synced_at);
    const days = [...new Set(withSync.map((r) => String(r.synced_at).slice(0, 10)))].sort();
    console.log(`   ${nm}: ${withSync.length}/${rows.length} rows carry synced_at - newest ${days.at(-1) ?? "-"} - oldest ${days[0] ?? "-"}`);
  }

  const codes = [...new Set([...A, ...B].map((r) => (r.city_identifier ?? "").trim()))].filter(Boolean);
  const unknown = codes.filter((c) => !CITY_CODE_TO_DISPLAY[c]);
  console.log(`\n-- city codes seen: ${codes.length} - unmapped: ${unknown.length ? JSON.stringify(unknown) : "none"} --`);

  const ta = total(A), tb = total(B);
  console.log("\n-- 1. THE FOUR DEFINITIONS OF SPOTS, A -> B --");
  console.log(`   ${pad("measure", 12)} ${pad("week A", 9)} ${pad("week B", 9)} ${pad("delta", 9)}`);
  const deltas: Record<string, number> = {};
  for (const k of ["real", "filled", "capacity", "fieldSpots"] as const) {
    deltas[k] = tb[k] - ta[k];
    console.log(`   ${pad(k, 12)} ${num(ta[k], 9)} ${num(tb[k], 9)} ${sgn(deltas[k], 9)}`);
  }
  console.log(`   ${pad("fake", 12)} ${num(ta.fake, 9)} ${num(tb.fake, 9)} ${sgn(tb.fake - ta.fake, 9)}`);
  console.log(`   ${pad("matches ran", 12)} ${num(ta.matches, 9)} ${num(tb.matches, 9)} ${sgn(tb.matches - ta.matches, 9)}`);
  console.log(`   ${pad("cancelled", 12)} ${num(ta.cancelled, 9)} ${num(tb.cancelled, 9)} ${sgn(tb.cancelled - ta.cancelled, 9)}`);
  const near400 = Object.entries(deltas).filter(([, v]) => Math.abs(Math.abs(v) - 400) <= 120).map(([k]) => k);
  console.log(`   -> within 120 of 400: ${near400.length ? near400.join(", ") : "none"}`);

  /* real = matches x spotsOffered x fillRate. Chained so the three sum EXACTLY, no residual. */
  const split = (a: Agg, b: Agg) => {
    const offA = a.matches ? a.capacity / a.matches : 0, offB = b.matches ? b.capacity / b.matches : 0;
    const fillA = a.capacity ? a.real / a.capacity : 0, fillB = b.capacity ? b.real / b.capacity : 0;
    const byMatches = (b.matches - a.matches) * offA * fillA;
    const byOffered = b.matches * (offB - offA) * fillA;
    const byFill = b.matches * offB * (fillB - fillA);
    return { byMatches, byOffered, byFill, offA, offB, fillA, fillB, sum: byMatches + byOffered + byFill };
  };
  const s = split(ta, tb);
  console.log("\n-- 3. WHERE THE MOVEMENT CAME FROM (real players) --");
  console.log(`   fewer/more matches ran      ${sgn(s.byMatches, 9)}   (${ta.matches} -> ${tb.matches} matches)`);
  console.log(`   spots offered per match     ${sgn(s.byOffered, 9)}   (${s.offA.toFixed(1)} -> ${s.offB.toFixed(1)})`);
  console.log(`   fill rate                   ${sgn(s.byFill, 9)}   (${(s.fillA * 100).toFixed(1)}% -> ${(s.fillB * 100).toFixed(1)}%)`);
  console.log(`   total                       ${sgn(s.sum, 9)}   vs measured ${sgn(deltas.real, 0)}`);
  assert("the three-way split sums to the real delta", Math.abs(s.sum - deltas.real) < 0.5, `${s.sum.toFixed(2)} vs ${deltas.real}`);

  const ca = rollup(A, cityOf), cb = rollup(B, cityOf);
  const cities = [...new Set([...ca.keys(), ...cb.keys()])];
  const cityRows = cities.map((c) => {
    const a = ca.get(c) ?? zero(), b = cb.get(c) ?? zero();
    return { c, a, b, d: b.real - a.real };
  }).sort((x, y) => x.d - y.d);
  console.log("\n-- 4. BY CITY, real players, ranked by contribution --");
  console.log(`   ${pad("city", 22)} ${pad("A", 7)} ${pad("B", 7)} ${pad("delta", 8)} ${pad("share", 7)} ${pad("matches", 11)} ${pad("fill A->B", 14)}`);
  for (const r of cityRows) {
    const share = deltas.real ? (r.d / deltas.real) * 100 : 0;
    const fA = r.a.capacity ? (r.a.real / r.a.capacity) * 100 : 0, fB = r.b.capacity ? (r.b.real / r.b.capacity) * 100 : 0;
    console.log(`   ${pad(r.c, 22)} ${num(r.a.real, 7)} ${num(r.b.real, 7)} ${sgn(r.d, 8)} ${pad(`${share.toFixed(0)}%`, 7)} ${pad(`${r.a.matches} -> ${r.b.matches}`, 11)} ${pad(`${fA.toFixed(0)}% -> ${fB.toFixed(0)}%`, 14)}`);
  }
  const citySum = cityRows.reduce((t, r) => t + r.d, 0);
  assert("city deltas sum EXACTLY to the network delta", citySum === deltas.real, `${citySum} vs ${deltas.real}`);

  const isNew = (c: string) => /Warsaw|WAW/.test(c);
  const exNew = cityRows.filter((r) => !isNew(r.c));
  const newCities = cityRows.filter((r) => isNew(r.c));
  console.log(`\n-- 2. THE NETWORK NUMBER --`);
  console.log(`   real, all cities                    ${sgn(deltas.real, 8)}`);
  console.log(`   real, excluding ${pad(newCities.map((r) => r.c).join(", ") || "nothing", 20)}${sgn(exNew.reduce((t, r) => t + r.d, 0), 8)}`);
  console.log(`   cancelled matches                   ${ta.cancelled} -> ${tb.cancelled}  (${sgn(tb.cancelled - ta.cancelled, 0)})`);
  console.log(`   matches that RAN                    ${ta.matches} -> ${tb.matches}  (${sgn(tb.matches - ta.matches, 0)})`);

  const SEP = "|||";
  const fa = rollup(A, (r) => `${cityOf(r)}${SEP}${fieldOf(r)}`), fb = rollup(B, (r) => `${cityOf(r)}${SEP}${fieldOf(r)}`);
  const keys = [...new Set([...fa.keys(), ...fb.keys()])];
  const fieldRows = keys.map((k) => {
    const [city, field] = k.split(SEP);
    const a = fa.get(k) ?? zero(), b = fb.get(k) ?? zero();
    return { city, field, a, b, d: b.real - a.real };
  }).sort((x, y) => x.d - y.d);
  let cityFieldOk = true;
  for (const c of cities) {
    const want = (cb.get(c) ?? zero()).real - (ca.get(c) ?? zero()).real;
    const got = fieldRows.filter((f) => f.city === c).reduce((t, f) => t + f.d, 0);
    if (got !== want) { cityFieldOk = false; assert(`field deltas sum to ${c}`, false, `${got} vs ${want}`); }
  }
  assert("field deltas sum EXACTLY to each city's delta, every city", cityFieldOk);
  const show = (rs: typeof fieldRows, title: string) => {
    console.log(`\n   ${title}`);
    console.log(`   ${pad("field", 32)} ${pad("city", 14)} ${pad("A", 6)} ${pad("B", 6)} ${pad("delta", 8)} ${pad("matches", 11)}`);
    for (const r of rs) console.log(`   ${pad(r.field.slice(0, 31), 32)} ${pad(r.city.slice(0, 13), 14)} ${num(r.a.real, 6)} ${num(r.b.real, 6)} ${sgn(r.d, 8)} ${pad(`${r.a.matches} -> ${r.b.matches}`, 11)}`);
  };
  console.log("\n-- 5. BY FIELD --");
  show(fieldRows.filter((r) => r.d < 0).slice(0, 10), "the ten fields that FELL most");
  show(fieldRows.filter((r) => r.d > 0).sort((x, y) => y.d - x.d).slice(0, 10), "the ten fields that ROSE most");

  const raw = new Map<string, Set<string>>();
  for (const r of [...A, ...B]) { const c = fieldOf(r); if (!raw.has(c)) raw.set(c, new Set()); raw.get(c)!.add((r.field_title ?? "").trim()); }
  const collapsed = [...raw.entries()].filter(([, v]) => v.size > 1).sort((a, b) => b[1].size - a[1].size);
  console.log(`\n-- 8. canonicalVenueName collapsed ${collapsed.length} of ${raw.size} names from more than one raw title --`);
  for (const [c, v] of collapsed.slice(0, 8)) console.log(`   ${pad(c, 28)} <- ${v.size}: ${[...v].slice(0, 3).map((x) => JSON.stringify(x.slice(0, 24))).join(", ")}${v.size > 3 ? " ..." : ""}`);

  return { ok: true as const, deltas, ta, tb, cityRows };
}

await compare(aF, aT, bF, bT);

const back = (d: string) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCFullYear(t.getUTCFullYear() - 1); return t.toISOString().slice(0, 10); };
console.log(`\n\n${"".padEnd(96, "#")}\n# 6. SEASONAL CONTROL - the same two weeks a year earlier\n${"".padEnd(96, "#")}`);
const ctl = await compare(back(aF), back(aT), back(bF), back(bT), "CONTROL ");
if (!ctl.ok) console.log("\n   THE MIRROR DOES NOT SUPPORT A 2025 CONTROL for these weeks - stated rather than skipped.");

console.log(`\n${FAILED === 0 ? "all reconciliation assertions passed" : `${FAILED} RECONCILIATION ASSERTION(S) FAILED - do not trust the breakdown above`}`);
if (FAILED) process.exit(1);

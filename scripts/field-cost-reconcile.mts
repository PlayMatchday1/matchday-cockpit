/* JULY 2026 FIELD COST, EXPECTED vs QUICKBOOKS. READ-ONLY - selects only.
 *
 *   npx tsx scripts/field-cost-reconcile.mts [YYYY-MM]
 *
 * TWO PREMISES OF THE BRIEF ARE WRONG AND THIS SCRIPT IS BUILT ON WHAT IS ACTUALLY THERE:
 *   - fin_venues DOES carry per-venue rates. per_match_rate / cost_per_match / monthly_flat are
 *     populated on 32 of 35 venues. Expected cost IS computable today.
 *   - fin_expenses holds NO field cost. 336 rows across nine categories, none of them a venue or
 *     field line. So the QuickBooks side is not in this database and cannot be confirmed here.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
for (const l of readFileSync(".env.local", "utf8").split("\n")) {
  const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const { canonicalVenueName } = await import("../src/lib/venueResolver");
const { CITY_CODE_TO_DISPLAY } = await import("../src/lib/scheduleReconcile");

const YM = process.argv[2] || "2026-07";
const [Y, M] = YM.split("-").map(Number);
const NEXT = `${M === 12 ? Y + 1 : Y}-${String(M === 12 ? 1 : M + 1).padStart(2, "0")}-01`;
const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pad = (s: unknown, w: number) => String(s).padEnd(w);
const rt = (s: unknown, w: number) => String(s).padStart(w);

/* RYAN'S QUICKBOOKS SIDE, transcribed from the brief. NOT confirmable from this database - there is
 * no QB integration and fin_expenses carries no field lines. Stated, not silently trusted. */
const QB: Record<string, { amount: number; lines: number }> = {
  "Soccer Central": { amount: 9720.00, lines: 58 },
  "UNIDENTIFIED wire": { amount: 8640.00, lines: 1 },
  "ATH (Pearland/Katy)": { amount: 1960.00, lines: 1 },
  "Round Rock": { amount: 1531.00, lines: 2 },
  "PracticePlan (platform)": { amount: 1262.00, lines: 2 },
  "City of Southlake": { amount: 1250.00, lines: 1 },
  "The Hattrick": { amount: 1087.50, lines: 1 },
  "Scissortail Park": { amount: 877.50, lines: 1 },
  "Facilitron (schools)": { amount: 645.42, lines: 5 },
  "New Braunfels Parks": { amount: 120.00, lines: 1 },
};
const QB_TOTAL = Object.values(QB).reduce((t, x) => t + x.amount, 0);

const [{ data: venues }, { data: links }] = await Promise.all([
  sb.from("fin_venues").select("id, venue_name, city, billing_type, per_match_rate, cost_per_match, monthly_flat, hourly_rate, charge_on_cancel, bills_per_reservation, is_active"),
  sb.from("fin_venue_fields").select("fin_venue_id, mdapi_field_id, counts_as_regular_play, excluded_from_venue"),
]);
const venueById = new Map((venues ?? []).map((v: any) => [v.id, v]));
const venueOfField = new Map<number, any>();
for (const l of links ?? []) {
  const v = venueById.get((l as any).fin_venue_id);
  if (v && !(l as any).excluded_from_venue) venueOfField.set(Number((l as any).mdapi_field_id), v);
}

const matches: any[] = [];
for (let p = 0; ; p++) {
  const { data, error } = await sb.from("mdapi_matches")
    .select("api_id, start_date, city_identifier, field_id, field_title, is_cancelled, player_count, max_player_count")
    .gte("start_date", `${YM}-01`).lt("start_date", NEXT).is("deleted_at", null)
    .order("start_date").range(p * 1000, p * 1000 + 999);
  if (error) throw new Error(error.message);
  matches.push(...(data ?? []));
  if ((data ?? []).length < 1000) break;
}

console.log(`\n${"".padEnd(100, "=")}\nJULY-STYLE FIELD COST RECONCILIATION - ${YM}\n${"".padEnd(100, "=")}`);
console.log(`\n${matches.length} matches in the mirror for ${YM}`);

/* THE CANCELLED-MATCH RULE IS PER VENUE, NOT A BLANKET 12 HOURS. fin_venues.charge_on_cancel says
 * whether that venue bills for a cancelled reservation. There is NO cancellation timestamp anywhere
 * in mdapi_matches (checked: is_cancelled, auto_canceled, auto_canceled_minutes, created_at,
 * updated_at, deleted_at - and no canceled_at), so a twelve-hour notice test cannot be computed at
 * all. The venue flag is the only rule the data supports, and it is used here. */
type Agg = { venue: any; ran: number; cancelledCharged: number; cancelledFree: number; raw: Set<string> };
const byVenue = new Map<string, Agg>();
const unmappedFields = new Map<string, { n: number; city: string }>();
for (const m of matches) {
  const v = m.field_id != null ? venueOfField.get(Number(m.field_id)) : undefined;
  const canon = canonicalVenueName(m.field_title) || "(no field_title)";
  if (!v) {
    /* NEVER `if (!v) continue`. An unmapped field is REPORTED - that pattern has silently dropped
     * rows twice in this codebase. */
    const k = `${canon} [field_id ${m.field_id ?? "null"}]`;
    const e = unmappedFields.get(k) ?? { n: 0, city: CITY_CODE_TO_DISPLAY[m.city_identifier ?? ""] ?? `${m.city_identifier}(UNMAPPED)` };
    e.n++; unmappedFields.set(k, e);
    continue;
  }
  const key = String(v.venue_name);
  if (!byVenue.has(key)) byVenue.set(key, { venue: v, ran: 0, cancelledCharged: 0, cancelledFree: 0, raw: new Set() });
  const a = byVenue.get(key)!;
  a.raw.add((m.field_title ?? "").trim());
  if (m.is_cancelled) { if (v.charge_on_cancel) a.cancelledCharged++; else a.cancelledFree++; }
  else a.ran++;
}

const rateOf = (v: any) => {
  const r = v.per_match_rate ?? v.cost_per_match;
  return r == null ? null : Number(r);
};

console.log(`\n-- EXPECTED COST FROM fin_venues RATES (the table the brief says does not exist) --`);
console.log(`${pad("venue", 26)}${pad("city", 13)}${rt("ran", 5)}${rt("cx+", 5)}${rt("cx-", 5)}${rt("rate", 9)}${rt("monthly", 10)}${rt("EXPECTED", 12)}  basis`);
let expTotal = 0, noRate: string[] = [];
const rows = [...byVenue.entries()].sort((a, b) => a[0].localeCompare(b[0]));
for (const [name, a] of rows) {
  const v = a.venue, rate = rateOf(v);
  const billable = a.ran + a.cancelledCharged;
  let expected = 0, basis = "";
  if (v.billing_type === "profit_share" && v.monthly_flat != null) { expected = Number(v.monthly_flat); basis = "monthly flat (profit share)"; }
  else if (rate != null && rate > 0) { expected = billable * rate; basis = `${billable} x ${usd(rate)}`; }
  else if (rate === 0) { basis = "rate recorded as 0"; }
  else { basis = "NO RATE RECORDED"; noRate.push(name); }
  expTotal += expected;
  console.log(`${pad(name.slice(0, 25), 26)}${pad(String(v.city ?? "-").slice(0, 12), 13)}${rt(a.ran, 5)}${rt(a.cancelledCharged, 5)}${rt(a.cancelledFree, 5)}${rt(rate ?? "-", 9)}${rt(v.monthly_flat ?? "-", 10)}${rt(usd(expected), 12)}  ${basis}`);
}
console.log(`${pad("", 26)}${pad("", 13)}${rt("", 5)}${rt("", 5)}${rt("", 5)}${rt("", 9)}${rt("TOTAL", 10)}${rt(usd(expTotal), 12)}`);

console.log(`\n-- QUICKBOOKS SIDE, as transcribed from the brief (NOT confirmable here) --`);
for (const [k, x] of Object.entries(QB).sort((a, b) => b[1].amount - a[1].amount))
  console.log(`   ${pad(k, 28)}${rt(usd(x.amount), 12)}${rt(x.lines, 5)} lines`);
console.log(`   ${pad("TOTAL", 28)}${rt(usd(QB_TOTAL), 12)}`);
console.log(`\n   expected from rates ${usd(expTotal)}  vs  QB ${usd(QB_TOTAL)}   variance ${usd(expTotal - QB_TOTAL)}`);

/* THE $8,640 BY ELIMINATION. */
console.log(`\n-- VENUES THAT RAN MATCHES WITH NO QB LINE, and the $8,640 divisor --`);
const qbNames = Object.keys(QB).map((k) => k.toLowerCase());
const matched = (n: string) => qbNames.some((q) => q.includes(n.toLowerCase().slice(0, 6)) || n.toLowerCase().includes(q.split(" ")[0]));
const WIRE = 8640;
console.log(`${pad("venue", 26)}${rt("billable", 10)}${rt("8640/n", 10)}${rt("recorded rate", 15)}  clean?`);
for (const [name, a] of rows) {
  if (matched(name)) continue;
  const n = a.ran + a.cancelledCharged; if (!n) continue;
  const div = WIRE / n, r = rateOf(a.venue);
  const clean = Math.abs(div - Math.round(div)) < 0.005;
  const matchesRate = r != null && Math.abs(div - r) < 0.51;
  console.log(`${pad(name.slice(0, 25), 26)}${rt(n, 10)}${rt(`$${div.toFixed(2)}`, 10)}${rt(r ?? "-", 15)}  ${matchesRate ? "<<< MATCHES ITS RECORDED RATE" : clean ? "round number" : "no"}`);
}

console.log(`\n-- CANONICALISATION: raw field titles collapsed per venue --`);
let collapsed = 0;
for (const [name, a] of rows) if (a.raw.size > 1) { collapsed++;
  console.log(`   ${pad(name.slice(0, 24), 26)} <- ${a.raw.size}: ${[...a.raw].slice(0, 3).map((x) => JSON.stringify(x.slice(0, 24))).join(", ")}`); }
console.log(`   ${collapsed} of ${rows.length} venues drew from more than one raw title`);

console.log(`\n-- FIELDS WITH MATCHES BUT NO fin_venue_fields MAPPING (reported, never skipped) --`);
if (!unmappedFields.size) console.log("   none");
for (const [k, v] of [...unmappedFields].sort((a, b) => b[1].n - a[1].n))
  console.log(`   ${rt(v.n, 4)} matches  ${pad(k.slice(0, 46), 48)} ${v.city}`);

console.log(`\n-- VENUES THAT RAN WITH NO RATE RECORDED --`);
console.log(noRate.length ? noRate.map((n) => `   ${n}`).join("\n") : "   none");

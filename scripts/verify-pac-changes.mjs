// Verify the math for the three PAC Global dashboard changes against
// live data, before pushing the code.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = readFileSync(
  "/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local",
  "utf8",
);
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

const fmt = (n) =>
  "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function getWeekMonday(iso) {
  const d = new Date(iso);
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() + diff);
  return monday.toISOString().slice(0, 10);
}

const VENUE = "PAC Global";

// 1. Find current upload.
const { data: upload } = await sb
  .from("data_uploads")
  .select("id")
  .eq("is_current", true)
  .order("created_at", { ascending: false })
  .limit(1)
  .maybeSingle();
console.log(`Active upload_id: ${upload?.id ?? "(none)"}`);

// 2. Pull all PAC registrations (paginate just in case).
let mr = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await sb
    .from("match_registrations")
    .select("user_id, email, field, match_start, match_canceled, player_canceled_at, payment_type, promocode, match_price_paid")
    .eq("upload_id", upload.id)
    .ilike("field", `%${VENUE}%`)
    .order("match_start")
    .range(from, from + 999);
  if (error) throw error;
  if (!data || data.length === 0) break;
  mr.push(...data);
  if (data.length < 1000) break;
}
console.log(`PAC registrations: ${mr.length}`);

// Drop staff
mr = mr.filter((r) => !(r.email && r.email.toLowerCase().includes("matchday.com")));
const pac = mr.filter((r) => !r.match_canceled);
console.log(`After staff drop: ${mr.length}, after match_canceled drop: ${pac.length}`);

// 3. Pull non-PROJECTION fin_revenue rows for the venue, with the
//    DPP/Membership filter (mirrors the partnerStats.ts query).
const { data: rev } = await sb
  .from("fin_revenue")
  .select("id, date, type, gross, source, notes")
  .ilike("venue", `%${VENUE}%`)
  .neq("source", "PROJECTION")
  .not("type", "in", '("DPP","Membership")');
console.log(`\nfin_revenue rows for PAC (non-PROJECTION): ${rev.length}`);
for (const r of rev) {
  console.log(`  id=${r.id} date=${r.date} type=${r.type} gross=${fmt(r.gross)} source=${r.source} notes="${r.notes ?? ""}"`);
}

// 4. Monthly summary (matches + revenue with extras)
const matchByMonth = new Map();
for (const r of pac) {
  const ym = r.match_start.slice(0, 7);
  let b = matchByMonth.get(ym);
  if (!b) { b = { matches: new Set(), rev: 0 }; matchByMonth.set(ym, b); }
  b.matches.add(r.match_start);
  b.rev += Number(r.match_price_paid ?? 0) || 0;
}
const extraByMonth = new Map();
for (const e of rev) {
  const ym = String(e.date).slice(0, 7);
  extraByMonth.set(ym, (extraByMonth.get(ym) ?? 0) + Number(e.gross ?? 0));
}

console.log(`\n=== Monthly summary (sorted oldest → newest) ===`);
console.log("YYYY-MM   MATCHES  MATCH-REV       EXTRA-REV   TOTAL-REV");
console.log("-".repeat(60));
const months = new Set([...matchByMonth.keys(), ...extraByMonth.keys()]);
for (const ym of [...months].sort()) {
  const m = matchByMonth.get(ym);
  const matchRev = m?.rev ?? 0;
  const extra = extraByMonth.get(ym) ?? 0;
  const total = matchRev + extra;
  console.log(
    `${ym}   ${String(m?.matches.size ?? 0).padStart(7)}  ${fmt(matchRev).padStart(12)}  ${fmt(extra).padStart(10)}  ${fmt(total).padStart(11)}`,
  );
}

// 5. Week-by-week with new fields
const weekMap = new Map();
for (const r of pac) {
  const wk = getWeekMonday(r.match_start);
  const arr = weekMap.get(wk) ?? [];
  arr.push(r);
  weekMap.set(wk, arr);
}
const allWeeksSet = new Set();
for (const r of mr) allWeeksSet.add(getWeekMonday(r.match_start));
const sortedWeeks = [...allWeeksSet].sort();
const extraByWeek = new Map();
for (const e of rev) {
  const wk = getWeekMonday(`${e.date}T00:00:00Z`);
  extraByWeek.set(wk, (extraByWeek.get(wk) ?? 0) + Number(e.gross ?? 0));
}

console.log(`\n=== Per-week (focus: revenue + DPP avg) ===`);
console.log("WK#  MONDAY      LABEL          MATCH-REV   EXTRA  TOTAL-REV   DPP-REV  DPP-SPOTS  AVG/MATCH");
console.log("-".repeat(110));
let i = 1;
for (const wk of sortedWeeks) {
  const wrows = weekMap.get(wk) ?? [];
  if (wrows.length === 0) {
    console.log(`W${i++} ${wk}  (voided)`);
    continue;
  }
  const matchRev = wrows.reduce((s, r) => s + (Number(r.match_price_paid ?? 0) || 0), 0);
  const extra = extraByWeek.get(wk) ?? 0;
  const totalRev = matchRev + extra;
  const dpRows = wrows.filter((r) => r.payment_type === "DAILY PAID");
  const dpRev = dpRows.reduce((s, r) => s + (Number(r.match_price_paid ?? 0) || 0), 0);
  const dpSpots = dpRows.length;
  const avg = dpSpots > 0 ? dpRev / dpSpots : null;
  // per-type extras for this week
  const extrasByType = new Map();
  for (const e of rev) {
    if (getWeekMonday(`${e.date}T00:00:00Z`) !== wk) continue;
    extrasByType.set(e.type, (extrasByType.get(e.type) ?? 0) + Number(e.gross ?? 0));
  }
  const extrasStr = [...extrasByType.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([t, v]) => `${t}=${fmt(v)}`)
    .join(", ") || "(none)";

  // Build the week's date label
  const dates = wrows.map((r) => r.match_start.slice(0, 10)).sort();
  const label = dates[0] === dates[dates.length - 1] ? dates[0] : `${dates[0]}…${dates[dates.length - 1]}`;
  console.log(
    `W${String(i++).padEnd(2)} ${wk}  ${label.padEnd(13)}  ${fmt(matchRev).padStart(9)}  ${fmt(extra).padStart(6)}  ${fmt(totalRev).padStart(9)}  ${fmt(dpRev).padStart(8)}  ${String(dpSpots).padStart(8)}  ${avg === null ? "—" : "$" + avg.toFixed(2)}  extras=${extrasStr}`,
  );
}

// 6. Verify $100 row lands in the right week
console.log(`\n=== Sanity: $100 row's week ===`);
for (const e of rev.filter((x) => Number(x.gross) === 100)) {
  console.log(`  ${e.date} → week-Monday = ${getWeekMonday(`${e.date}T00:00:00Z`)} (gross ${fmt(e.gross)})`);
}

// Preview Austin city card data for the new Weekly Projections tab.
// Mirrors the helper logic the tab will use:
//   - 4 historical Sun-Sat weeks ending most-recent-Saturday-on-or-before
//     today
//   - Next week (Sun after today's most-recent-Saturday)
//   - For each venue × week: matches (distinct match_start), DPP rev
//     (sum match_price_paid), avg = rev/matches.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = readFileSync(
  "/Users/ryanmancuso/Code/matchday-cockpit/.env.local",
  "utf8",
);
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

const fmt = (n) =>
  "$" + Math.round(Number(n) * 100) / 100;

function addDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function mostRecentSaturday(today) {
  const d = new Date(today);
  const day = d.getUTCDay(); // Sun=0..Sat=6
  const diff = day === 6 ? 0 : (day + 1) % 7;
  d.setUTCDate(d.getUTCDate() - diff);
  return d.toISOString().slice(0, 10);
}
function fmtRange(start, end) {
  // "Apr 5 - 11" or "Apr 26 - May 2"
  const s = new Date(`${start}T12:00:00Z`);
  const e = new Date(`${end}T12:00:00Z`);
  const sm = s.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
  const em = e.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
  const sd = s.getUTCDate();
  const ed = e.getUTCDate();
  return sm === em ? `${sm} ${sd}-${ed}` : `${sm} ${sd}-${em} ${ed}`;
}

const today = new Date();
const wMinus1End = mostRecentSaturday(today); // Saturday on/before today
const wMinus1Start = addDays(wMinus1End, -6); // Sunday
const nextStart = addDays(wMinus1End, 1); // Sunday after
const nextEnd = addDays(nextStart, 6);

const windows = [
  { idx: -4, start: addDays(wMinus1Start, -21), end: addDays(wMinus1End, -21) },
  { idx: -3, start: addDays(wMinus1Start, -14), end: addDays(wMinus1End, -14) },
  { idx: -2, start: addDays(wMinus1Start, -7), end: addDays(wMinus1End, -7) },
  { idx: -1, start: wMinus1Start, end: wMinus1End },
  { idx: 0, start: nextStart, end: nextEnd, isNext: true },
];

console.log(`Today (UTC): ${today.toISOString().slice(0, 10)}`);
console.log("Windows:");
for (const w of windows) {
  console.log(`  ${w.idx === 0 ? "Next" : `W${w.idx}`}  ${fmtRange(w.start, w.end)}`);
}

// Active upload for match_registrations.
const { data: upload } = await sb
  .from("data_uploads")
  .select("id")
  .eq("is_current", true)
  .order("created_at", { ascending: false })
  .limit(1)
  .maybeSingle();

// Austin venues.
const { data: venues } = await sb
  .from("fin_venues")
  .select("id, venue_name, city")
  .eq("city", "Austin")
  .order("venue_name");
console.log(`\nAustin venues: ${venues.length}`);
for (const v of venues) console.log(`  id=${v.id} ${v.venue_name}`);

// Pull venue aliases — match_registrations.field stores raw values
// like "The Hattrick" while fin_venues.venue_name is canonical
// "Hattrick". useMatchData applies this map; mirror it here.
const { data: aliases } = await sb
  .from("fin_venue_aliases")
  .select("alias, canonical_venue");
const aliasMap = new Map(
  (aliases ?? []).map((a) => [a.alias, a.canonical_venue]),
);

// Pull all Austin match_registrations active rows.
let allRows = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await sb
    .from("match_registrations")
    .select("city, field, match_start, match_canceled, payment_type, match_price_paid, email")
    .eq("upload_id", upload.id)
    .eq("city", "Austin")
    .order("match_start")
    .range(from, from + 999);
  if (error) throw error;
  if (!data || data.length === 0) break;
  allRows.push(...data);
  if (data.length < 1000) break;
}
console.log(`\nAustin match_registrations rows (raw): ${allRows.length}`);
const STAFF = "matchday.com";
allRows = allRows.filter((r) => !(r.email && r.email.toLowerCase().includes(STAFF)));
// Canonicalize field via alias map (mirrors useMatchData).
allRows = allRows.map((r) => ({
  ...r,
  field: aliasMap.get(r.field) ?? r.field,
}));
const active = allRows.filter((r) => !r.match_canceled);
console.log(`After staff drop + match_canceled drop: ${active.length}`);

// Walkthrough fields: pick a few.
const PICKS = ["San Juan Diego", "NEMP", "Hattrick", "Stony Point", "Round Rock"];

function statsForFieldWeek(venueName, start, end) {
  // Substring match (case-insensitive) — mirrors partnerStats.ts's
  // `field ILIKE '%<venue_name>%'` so "The Hattrick" matches venue
  // "Hattrick", "ATH Katy Sunday" matches "ATH Katy", etc. Same
  // robustness as the partner-facing reader.
  const needle = venueName.toLowerCase();
  const rows = active.filter(
    (r) =>
      (r.field ?? "").toLowerCase().includes(needle) &&
      r.match_start.slice(0, 10) >= start &&
      r.match_start.slice(0, 10) <= end,
  );
  const matches = new Set(rows.map((r) => r.match_start)).size;
  // DPP rev only includes rows where payment_type === 'DAILY PAID'.
  const dppRev = rows
    .filter((r) => r.payment_type === "DAILY PAID")
    .reduce((s, r) => s + Number(r.match_price_paid ?? 0), 0);
  const avg = matches > 0 ? dppRev / matches : 0;
  return { matches, dppRev, avg };
}

console.log("\n=== Austin city card preview ===");
console.log(
  "FIELD                         W-4         W-3         W-2         W-1         NEXT (planned)",
);
console.log("-".repeat(125));
for (const f of PICKS) {
  const cells = windows.map((w) =>
    w.isNext
      ? null // For "next", we use scheduled match_starts in match_registrations
      : statsForFieldWeek(f, w.start, w.end),
  );
  // Next week defaults: matches = distinct match_starts already in
  // match_registrations for the next-week window. Avg price defaults
  // to W-1's avg.
  const needle = f.toLowerCase();
  const nextScheduled = active.filter(
    (r) =>
      (r.field ?? "").toLowerCase().includes(needle) &&
      r.match_start.slice(0, 10) >= nextStart &&
      r.match_start.slice(0, 10) <= nextEnd,
  );
  const nextMatches = new Set(nextScheduled.map((r) => r.match_start)).size;
  const wMinus1 = cells[3];
  const nextAvgDefault = wMinus1.avg;
  const nextProjected = nextMatches * nextAvgDefault;

  const cellStr = (c) => {
    if (!c) return "—".padStart(11);
    if (c.matches === 0) return "—".padStart(11);
    return `${c.matches}m ${fmt(c.avg)}/m ${fmt(c.dppRev)}`.padStart(11);
  };
  const nextStr = `${nextMatches}m ${fmt(nextAvgDefault)}/m ${fmt(nextProjected)}`;
  console.log(
    `${f.padEnd(28)}  ${cellStr(cells[0]).padEnd(12)} ${cellStr(cells[1]).padEnd(12)} ${cellStr(cells[2]).padEnd(12)} ${cellStr(cells[3]).padEnd(12)} ${nextStr}`,
  );
}

console.log("\nLegend: 'Nm' = N distinct matches | '$X/m' = avg DPP rev per match | '$Y' = total DPP rev");

// Preview cancelled-match counts per (venue, week) for the projections
// tab. Mirrors the logic just added to projectionsStats.ts so we can
// eyeball NEMP W-2 + grand totals with live data.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = readFileSync(
  "/Users/ryanmancuso/Code/matchday-cockpit/.env.local",
  "utf8",
);
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

const STAFF_DOMAIN = "matchday.com";

function addDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function mostRecentSaturday(now) {
  const today = now.toISOString().slice(0, 10);
  const d = new Date(`${today}T00:00:00Z`);
  const day = d.getUTCDay();
  const diff = day === 6 ? 0 : (day + 1) % 7;
  d.setUTCDate(d.getUTCDate() - diff);
  return d.toISOString().slice(0, 10);
}
function fmtRange(start, end) {
  const s = new Date(`${start}T12:00:00Z`);
  const e = new Date(`${end}T12:00:00Z`);
  const sm = s.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
  const em = e.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
  const sd = s.getUTCDate();
  const ed = e.getUTCDate();
  return sm === em ? `${sm} ${sd}-${ed}` : `${sm} ${sd}-${em} ${ed}`;
}

const now = new Date();
const w1End = mostRecentSaturday(now);
const w1Start = addDays(w1End, -6);
const windows = [
  { start: addDays(w1Start, -21), end: addDays(w1End, -21) }, // W-4
  { start: addDays(w1Start, -14), end: addDays(w1End, -14) }, // W-3
  { start: addDays(w1Start, -7), end: addDays(w1End, -7) }, // W-2
  { start: w1Start, end: w1End }, // W-1
].map((w) => ({ ...w, label: fmtRange(w.start, w.end) }));

console.log("Today:", now.toISOString().slice(0, 10));
windows.forEach((w, i) => console.log(`  W-${4 - i}: ${w.label} (${w.start} → ${w.end})`));

const { data: upload } = await sb
  .from("data_uploads")
  .select("id")
  .eq("is_current", true)
  .order("created_at", { ascending: false })
  .limit(1)
  .maybeSingle();
if (!upload) throw new Error("No current data upload");

const earliest = windows[0].start;
const latest = windows[3].end;

const regs = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await sb
    .from("match_registrations")
    .select("field, match_start, match_canceled, payment_type, match_price_paid, email")
    .eq("upload_id", upload.id)
    .gte("match_start", `${earliest}T00:00:00Z`)
    .lte("match_start", `${latest}T23:59:59Z`)
    .range(from, from + 999);
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) break;
  regs.push(...data);
  if (data.length < 1000) break;
}

const { data: venues } = await sb
  .from("fin_venues")
  .select("id, venue_name, city")
  .order("city")
  .order("venue_name");

console.log(`\nFetched ${regs.length} registrations across ${windows[0].start}…${windows[3].end}`);

// Mirror compute logic.
const regsExStaff = regs.filter(
  (r) => !!r.field && !(r.email && r.email.toLowerCase().includes(STAFF_DOMAIN)),
);
const fields = new Set(regsExStaff.map((r) => r.field).filter(Boolean));
const fieldToVenue = new Map();
for (const f of fields) {
  const lf = f.toLowerCase();
  let best = null;
  for (const v of venues) {
    const ln = v.venue_name.toLowerCase();
    if (!ln || !lf.includes(ln)) continue;
    if (!best || ln.length > best.nameLen || (ln.length === best.nameLen && v.venue_name < best.name)) {
      best = { id: v.id, name: v.venue_name, nameLen: ln.length };
    }
  }
  if (best) fieldToVenue.set(f, best.id);
}

function statsForVenueWindow(venueId, w) {
  const matchSet = new Set();
  const cancelSet = new Set();
  for (const r of regsExStaff) {
    if (fieldToVenue.get(r.field) !== venueId) continue;
    const ymd = r.match_start.slice(0, 10);
    if (ymd < w.start || ymd > w.end) continue;
    if (r.match_canceled) cancelSet.add(r.match_start);
    else matchSet.add(r.match_start);
  }
  return { matches: matchSet.size, cancels: cancelSet.size };
}

// === NEMP all 4 weeks ===
const nemp = venues.find((v) => v.venue_name.toUpperCase().includes("NEMP"));
if (nemp) {
  console.log(`\n=== ${nemp.city} · ${nemp.venue_name} ===`);
  for (let i = 0; i < 4; i++) {
    const w = windows[i];
    const s = statsForVenueWindow(nemp.id, w);
    console.log(
      `  W-${4 - i} ${w.label.padEnd(14)} matches: ${String(s.matches).padStart(2)}  cancels: ${String(s.cancels).padStart(2)}`,
    );
  }
} else {
  console.log("\n(NEMP venue not found in fin_venues)");
}

// === All venues with cancellations in W-2 ===
console.log(`\n=== Venues with cancellations in W-2 (${windows[2].label}) ===`);
const w2Cancels = [];
for (const v of venues) {
  const s = statsForVenueWindow(v.id, windows[2]);
  if (s.cancels > 0) w2Cancels.push({ ...v, ...s });
}
w2Cancels.sort((a, b) => b.cancels - a.cancels);
for (const v of w2Cancels) {
  console.log(`  ${(v.city + " · " + v.venue_name).padEnd(40)} matches: ${String(v.matches).padStart(2)}  cancels: ${String(v.cancels).padStart(2)}`);
}
if (w2Cancels.length === 0) console.log("  (none)");

// === Week-by-week cancellation totals across all venues ===
console.log(`\n=== Total cancelled matches per week (all venues) ===`);
for (let i = 0; i < 4; i++) {
  const w = windows[i];
  let total = 0;
  for (const v of venues) total += statsForVenueWindow(v.id, w).cancels;
  console.log(`  W-${4 - i} ${w.label.padEnd(14)} ${String(total).padStart(3)} cancelled matches`);
}

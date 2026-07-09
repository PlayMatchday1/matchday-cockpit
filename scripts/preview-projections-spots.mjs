// Preview DPP spots + avg price/spot per (venue, week) for the
// projections tab. Mirrors the new logic in projectionsStats.ts so we
// can eyeball NEMP and a handful of other venues with live data.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = readFileSync(
  "/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local",
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
  return sm === em
    ? `${sm} ${s.getUTCDate()}-${e.getUTCDate()}`
    : `${sm} ${s.getUTCDate()}-${em} ${e.getUTCDate()}`;
}

const now = new Date();
const w1End = mostRecentSaturday(now);
const w1Start = addDays(w1End, -6);
const windows = [
  { start: addDays(w1Start, -21), end: addDays(w1End, -21) },
  { start: addDays(w1Start, -14), end: addDays(w1End, -14) },
  { start: addDays(w1Start, -7), end: addDays(w1End, -7) },
  { start: w1Start, end: w1End },
].map((w) => ({ ...w, label: fmtRange(w.start, w.end) }));

console.log("Today:", now.toISOString().slice(0, 10));
windows.forEach((w, i) => console.log(`  W-${4 - i}: ${w.label}`));

const { data: upload } = await sb
  .from("data_uploads")
  .select("id")
  .eq("is_current", true)
  .order("created_at", { ascending: false })
  .limit(1)
  .maybeSingle();

const earliest = windows[0].start;
const latest = windows[3].end;

const regs = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await sb
    .from("match_registrations")
    .select(
      "field, match_start, match_canceled, player_canceled_at, payment_type, match_price_paid, email",
    )
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

console.log(`\nFetched ${regs.length} registrations\n`);

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
  let dppRev = 0;
  let dppSpots = 0;
  let dppRevForSpots = 0;
  for (const r of regsExStaff) {
    if (fieldToVenue.get(r.field) !== venueId) continue;
    if (r.match_canceled) continue;
    const ymd = r.match_start.slice(0, 10);
    if (ymd < w.start || ymd > w.end) continue;
    matchSet.add(r.match_start);
    if (r.payment_type === "DAILY PAID") {
      const price = Number(r.match_price_paid ?? 0) || 0;
      dppRev += price;
      const playerCancel = !!r.player_canceled_at && r.player_canceled_at.trim() !== "";
      if (!playerCancel) {
        dppSpots += 1;
        dppRevForSpots += price;
      }
    }
  }
  const matches = matchSet.size;
  return {
    matches,
    dppSpots,
    dppRev,
    avgPrice: matches > 0 ? dppRev / matches : 0,
    avgPricePerSpot: dppSpots > 0 ? dppRevForSpots / dppSpots : null,
  };
}

const fmtUsd = (n) => "$" + Math.round(n).toLocaleString("en-US");
const fmtUsdDec = (n) => "$" + n.toFixed(2);

function printVenue(label, venueName) {
  const v = venues.find((x) => x.venue_name === venueName);
  if (!v) {
    console.log(`(${venueName} not found)`);
    return;
  }
  console.log(`=== ${label} · ${v.venue_name} ===`);
  for (let i = 0; i < 4; i++) {
    const w = windows[i];
    const s = statsForVenueWindow(v.id, w);
    const aps = s.avgPricePerSpot === null ? "—" : fmtUsdDec(s.avgPricePerSpot);
    const apm = s.matches > 0 ? fmtUsdDec(s.avgPrice) : "—";
    console.log(
      `  W-${4 - i} ${w.label.padEnd(14)} matches:${String(s.matches).padStart(3)}  dpp spots:${String(s.dppSpots).padStart(4)}  $/spot:${aps.padStart(8)}  $/match:${apm.padStart(8)}  rev:${fmtUsd(s.dppRev).padStart(8)}`,
    );
  }
  console.log("");
}

printVenue("Austin", "NEMP");
printVenue("Austin", "Hattrick");
printVenue("Austin", "San Juan Diego");
printVenue("Houston", "PAC Global");
printVenue("Dallas", "Bicentennial Park");

// All venues W-1 sanity sweep — flag anything where avg/spot looks off
console.log("=== W-1 sanity sweep — venues with > 0 DPP spots ===");
const w1 = windows[3];
const rows = [];
for (const v of venues) {
  const s = statsForVenueWindow(v.id, w1);
  if (s.dppSpots > 0) rows.push({ ...v, ...s });
}
rows.sort((a, b) => b.dppSpots - a.dppSpots);
for (const r of rows) {
  const aps = r.avgPricePerSpot === null ? "—" : fmtUsdDec(r.avgPricePerSpot);
  console.log(
    `  ${(r.city + " · " + r.venue_name).padEnd(40)} matches:${String(r.matches).padStart(3)}  spots:${String(r.dppSpots).padStart(4)}  $/spot:${aps.padStart(8)}`,
  );
}

// Verify PRUMC's next-week cell defaults match the new model:
//   matches default = next-week scheduled count
//   dpp spots default = round(mean(W-4..W-1 dppSpots))
//   avg/spot default = W-1's avgPricePerSpot
//   projected rev = dpp_spots × avg/spot
//   derived avg/match = rev / matches
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
  return sm === em
    ? `${sm} ${s.getUTCDate()}-${e.getUTCDate()}`
    : `${sm} ${s.getUTCDate()}-${em} ${e.getUTCDate()}`;
}

const now = new Date();
const w1End = mostRecentSaturday(now);
const w1Start = addDays(w1End, -6);
const nextStart = addDays(w1End, 1);
const nextEnd = addDays(nextStart, 6);
const windows = [
  { start: addDays(w1Start, -21), end: addDays(w1End, -21) },
  { start: addDays(w1Start, -14), end: addDays(w1End, -14) },
  { start: addDays(w1Start, -7), end: addDays(w1End, -7) },
  { start: w1Start, end: w1End },
].map((w) => ({ ...w, label: fmtRange(w.start, w.end) }));
const nextWindow = { start: nextStart, end: nextEnd, label: fmtRange(nextStart, nextEnd) };

console.log("Today:", now.toISOString().slice(0, 10));
windows.forEach((w, i) => console.log(`  W-${4 - i}: ${w.label}`));
console.log(`  Next: ${nextWindow.label}\n`);

const { data: upload } = await sb
  .from("data_uploads")
  .select("id")
  .eq("is_current", true)
  .order("created_at", { ascending: false })
  .limit(1)
  .maybeSingle();

const earliest = windows[0].start;
const latest = nextWindow.end;

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
  .order("venue_name");

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

const v = venues.find((x) => x.venue_name === "PRUMC");
if (!v) {
  console.log("PRUMC not found in fin_venues. Available venues containing 'PRUM':");
  for (const x of venues) if (x.venue_name.toLowerCase().includes("prum")) console.log("  ", x.venue_name);
  process.exit(0);
}

console.log(`=== ${v.city ?? "—"} · ${v.venue_name} ===`);
const fmtUsdDec = (n) => "$" + n.toFixed(2);
const fmtUsd = (n) => "$" + Math.round(n).toLocaleString("en-US");

const weekStats = windows.map((w) => statsForVenueWindow(v.id, w));
for (let i = 0; i < 4; i++) {
  const s = weekStats[i];
  const aps = s.avgPricePerSpot === null ? "—" : fmtUsdDec(s.avgPricePerSpot);
  const apm = s.matches > 0 ? fmtUsdDec(s.avgPrice) : "—";
  console.log(
    `  W-${4 - i} ${windows[i].label.padEnd(14)} matches:${String(s.matches).padStart(3)}  spots:${String(s.dppSpots).padStart(4)}  $/spot:${aps.padStart(8)}  $/match:${apm.padStart(8)}  rev:${fmtUsd(s.dppRev).padStart(8)}`,
  );
}

// Next-week scheduled match count
const nextMatchSet = new Set();
for (const r of regsExStaff) {
  if (fieldToVenue.get(r.field) !== v.id) continue;
  if (r.match_canceled) continue;
  const ymd = r.match_start.slice(0, 10);
  if (ymd < nextWindow.start || ymd > nextWindow.end) continue;
  nextMatchSet.add(r.match_start);
}

const w1 = weekStats[3];
const spotsMean = weekStats.reduce((s, w) => s + w.dppSpots, 0) / weekStats.length;
const dppSpotsDefault = Math.round(spotsMean);
const avgPricePerSpotDefault = w1.avgPricePerSpot;
const matchesDefault = nextMatchSet.size;
const projectedRev =
  avgPricePerSpotDefault === null ? 0 : dppSpotsDefault * avgPricePerSpotDefault;
const derivedAvgPerMatch = matchesDefault > 0 ? projectedRev / matchesDefault : 0;

console.log("\n--- Next-week defaults ---");
console.log(`  matches default     = ${matchesDefault} (distinct match_starts already scheduled in ${nextWindow.label})`);
console.log(`  spots mean (W-4..W-1) = ${weekStats.map((w) => w.dppSpots).join(" + ")} / 4 = ${spotsMean.toFixed(2)}`);
console.log(`  dpp spots default   = ${dppSpotsDefault} (rounded)`);
console.log(`  avg $/spot default  = ${avgPricePerSpotDefault === null ? "—" : fmtUsdDec(avgPricePerSpotDefault)} (W-1's $/spot)`);
console.log(`  projected rev       = ${dppSpotsDefault} × ${avgPricePerSpotDefault === null ? "—" : fmtUsdDec(avgPricePerSpotDefault)} = ${fmtUsd(projectedRev)}`);
console.log(`  derived avg/match   = ${fmtUsd(projectedRev)} ÷ ${matchesDefault} = ${matchesDefault > 0 ? fmtUsdDec(derivedAvgPerMatch) : "—"}`);

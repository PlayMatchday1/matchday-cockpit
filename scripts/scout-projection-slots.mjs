// Scout the (venue, dow, time) slot model proposed for the projections
// refactor. Mirrors projectionsStats.ts logic exactly: same window math,
// same staff filter, same field-to-venue resolver, same active/cancel
// split — but groups stats by (venueId, dow, hhmm) rather than venueId.
//
// Output:
//   1. Slot counts for NEMP, San Juan Diego, Hattrick (sanity check)
//   2. Atlanta city card walkthrough — every slot under every venue
//      with W-4..W-1 stats and weeks-with-data ratio (the "thin slot"
//      signal).
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
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

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

// match_start values look like "2026-04-28T19:00:00" — local match time
// stored without TZ. Slice to get the parts we need.
function dowFromYmd(ymd) {
  // Treat date as a calendar date — UTC parse keeps it stable.
  return new Date(`${ymd}T00:00:00Z`).getUTCDay();
}
function hhmmFromMatchStart(ms) {
  // chars 11-16 of "YYYY-MM-DDTHH:MM:SS"
  return ms.slice(11, 16);
}
function fmt12h(hhmm) {
  const [hStr, mStr] = hhmm.split(":");
  const h = Number(hStr);
  const m = Number(mStr);
  const ampm = h >= 12 ? "pm" : "am";
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${String(m).padStart(2, "0")}${ampm}`;
}
function slotLabel(dow, hhmm) {
  return `${DOW[dow]} ${fmt12h(hhmm)}`;
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
  .order("city")
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

// Compute slot stats: for each (venueId, dow, hhmm), per-week stats.
// Slot exists if it appears in W-4..W-1 OR next-week.
const slotMap = new Map(); // key -> { venueId, dow, hhmm, weeks: [W-4..W-1 stats], next: {...} }

function ensureSlot(venueId, dow, hhmm) {
  const key = `${venueId}|${dow}|${hhmm}`;
  let s = slotMap.get(key);
  if (!s) {
    s = {
      venueId,
      dow,
      hhmm,
      weeks: Array.from({ length: 4 }, () => ({
        matchSet: new Set(),
        cancelSet: new Set(),
        dppRev: 0,
        dppSpots: 0,
        dppRevForSpots: 0,
      })),
      next: { matchSet: new Set() },
    };
    slotMap.set(key, s);
  }
  return s;
}

function windowIndexFor(ymd) {
  for (let i = 0; i < 4; i++) {
    if (ymd >= windows[i].start && ymd <= windows[i].end) return i;
  }
  return -1;
}

for (const r of regsExStaff) {
  const venueId = fieldToVenue.get(r.field);
  if (!venueId) continue;
  const ymd = r.match_start.slice(0, 10);
  const hhmm = hhmmFromMatchStart(r.match_start);
  const dow = dowFromYmd(ymd);
  const slot = ensureSlot(venueId, dow, hhmm);

  const inNext = ymd >= nextWindow.start && ymd <= nextWindow.end;
  const wIdx = windowIndexFor(ymd);
  if (wIdx === -1 && !inNext) continue;

  if (inNext) {
    if (!r.match_canceled) slot.next.matchSet.add(r.match_start);
  } else {
    const w = slot.weeks[wIdx];
    if (r.match_canceled) {
      w.cancelSet.add(r.match_start);
    } else {
      w.matchSet.add(r.match_start);
      if (r.payment_type === "DAILY PAID") {
        const price = Number(r.match_price_paid ?? 0) || 0;
        w.dppRev += price;
        const playerCancel = !!r.player_canceled_at && r.player_canceled_at.trim() !== "";
        if (!playerCancel) {
          w.dppSpots += 1;
          w.dppRevForSpots += price;
        }
      }
    }
  }
}

function finalizeSlot(s) {
  const weekStats = s.weeks.map((w) => {
    const matches = w.matchSet.size;
    return {
      matches,
      cancels: w.cancelSet.size,
      dppSpots: w.dppSpots,
      dppRev: w.dppRev,
      avgPrice: matches > 0 ? w.dppRev / matches : 0,
      avgPricePerSpot: w.dppSpots > 0 ? w.dppRevForSpots / w.dppSpots : null,
    };
  });
  const weeksWithData = weekStats.filter((w) => w.matches > 0 || w.dppSpots > 0).length;
  return { ...s, weekStats, weeksWithData, nextMatches: s.next.matchSet.size };
}

const slots = [...slotMap.values()].map(finalizeSlot);
const slotsByVenue = new Map();
for (const s of slots) {
  const arr = slotsByVenue.get(s.venueId) ?? [];
  arr.push(s);
  slotsByVenue.set(s.venueId, arr);
}
for (const arr of slotsByVenue.values()) {
  arr.sort((a, b) => a.dow - b.dow || a.hhmm.localeCompare(b.hhmm));
}

const fmtUsd = (n) => "$" + Math.round(n).toLocaleString("en-US");
const fmtUsdDec = (n) => "$" + n.toFixed(2);

// === 1. Slot counts for sample venues ===
console.log("=== Slot counts (sanity check) ===");
for (const name of ["NEMP", "San Juan Diego", "Hattrick"]) {
  const v = venues.find((x) => x.venue_name === name);
  if (!v) {
    console.log(`  ${name}: NOT FOUND in fin_venues`);
    continue;
  }
  const arr = slotsByVenue.get(v.id) ?? [];
  console.log(`  ${name} (${v.city ?? "—"}): ${arr.length} slot(s)`);
  for (const s of arr) {
    console.log(`    - ${slotLabel(s.dow, s.hhmm)}  (${s.weeksWithData}/4 weeks with data)`);
  }
}
console.log("");

// === 2. Atlanta city card walkthrough ===
console.log("=== Atlanta city card walkthrough ===");
const atlVenues = venues.filter((v) => v.city === "Atlanta");
console.log(`Atlanta has ${atlVenues.length} venue(s) in fin_venues:`);
for (const v of atlVenues) {
  const arr = slotsByVenue.get(v.id) ?? [];
  console.log(`\n> ${v.venue_name} — ${arr.length} slot(s)`);
  if (arr.length === 0) {
    console.log("    (no activity in W-4..W-1 or next week)");
    continue;
  }

  // Venue-level W-1 totals (for the venue header summary)
  let venueW1Rev = 0;
  for (const s of arr) venueW1Rev += s.weekStats[3].dppRev;
  console.log(`    venue W-1 rev sum: ${fmtUsd(venueW1Rev)}`);

  for (const s of arr) {
    const label = slotLabel(s.dow, s.hhmm).padEnd(16);
    const cells = s.weekStats
      .map((w, i) => {
        if (w.matches === 0 && w.dppSpots === 0 && w.cancels === 0) return `W-${4 - i}: —`;
        const aps = w.avgPricePerSpot === null ? "—" : fmtUsdDec(w.avgPricePerSpot);
        return `W-${4 - i}: m=${w.matches} sp=${w.dppSpots} $/sp=${aps} rev=${fmtUsd(w.dppRev)}`;
      })
      .join("  |  ");
    console.log(`    ${label}  ${cells}  (${s.weeksWithData}/4)`);

    // Defaults for next-week
    const w1 = s.weekStats[3];
    const spotsMean = s.weekStats.reduce((acc, w) => acc + w.dppSpots, 0) / 4;
    const dppSpotsDefault = Math.round(spotsMean);
    const apsDefault = w1.avgPricePerSpot;
    const projectedRev = apsDefault === null ? null : dppSpotsDefault * apsDefault;
    console.log(
      `      → next defaults: matches=${s.nextMatches} (scheduled), spots=${dppSpotsDefault} (mean), $/spot=${apsDefault === null ? "—" : fmtUsdDec(apsDefault)} → rev=${projectedRev === null ? "—" : fmtUsd(projectedRev)}`,
    );
  }
}
console.log("");

// === 3. Edge case sweep ===
console.log("=== Edge cases across all slots ===");
const allSlots = [...slotsByVenue.values()].flat();
const thinSlots = allSlots.filter((s) => s.weeksWithData > 0 && s.weeksWithData < 4);
const oneWeekOnly = allSlots.filter((s) => s.weeksWithData === 1);
const newInW1 = allSlots.filter(
  (s) =>
    s.weekStats[3].matches > 0 &&
    s.weekStats[0].matches === 0 &&
    s.weekStats[1].matches === 0 &&
    s.weekStats[2].matches === 0,
);
const onlyNextNoHistory = allSlots.filter((s) => s.weeksWithData === 0 && s.nextMatches > 0);
console.log(`  total slots: ${allSlots.length}`);
console.log(`  thin (1-3 weeks of data): ${thinSlots.length}`);
console.log(`  thinnest (1 week only): ${oneWeekOnly.length}`);
console.log(`  new in W-1 (no W-4..W-2 data): ${newInW1.length}`);
console.log(`  only next-week scheduled (no history): ${onlyNextNoHistory.length}`);

// Replicate src/app/api/schedule-master/discrepancies/route.ts logic
// for the PRUMC May 19 7PM case and print the exact bucket keys.
// Read-only — no writes.

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = readFileSync(
  "/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local",
  "utf8",
);
const url = env.match(/^NEXT_PUBLIC_SUPABASE_URL=(.+)$/m)[1].trim();
const serviceKey = env.match(/^SUPABASE_SERVICE_ROLE_KEY=(.+)$/m)[1].trim();
const sb = createClient(url, serviceKey);

// --- exact copies of the route's helpers ---
const CITY_MAP = {
  austin: "ATX", atx: "ATX",
  atlanta: "ATL", atl: "ATL",
  dallas: "DFW", "dallas / fort worth": "DFW", "dallas/fort worth": "DFW", dfw: "DFW",
  houston: "HOU", hou: "HOU",
  "oklahoma city": "OKC", okc: "OKC",
  "san antonio": "SATX", satx: "SATX",
  "st. louis": "STL", "st louis": "STL", "saint louis": "STL", stl: "STL",
  "el paso": "ELP", elp: "ELP",
};
function normalizeCityName(raw) {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  return CITY_MAP[trimmed.toLowerCase()] ?? null;
}
function parseStartHHMM(time) {
  const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM|am|pm)?/.exec(time);
  if (!m) return "";
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ampm = m[3]?.toUpperCase();
  if (ampm === "PM" && h < 12) h += 12;
  if (ampm === "AM" && h === 12) h = 0;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}
function matchStart(raw) {
  if (!raw) return null;
  const ts = Date.parse(raw);
  if (Number.isNaN(ts)) return null;
  const d = new Date(ts);
  return {
    date: d.toISOString().slice(0, 10),
    hhmm: `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`,
  };
}
function matchCity(m) {
  const fromRaw = m.raw?.field?.city?.name;
  const fromCode = m.city_identifier;
  return normalizeCityName(fromRaw) ?? normalizeCityName(fromCode);
}

// --- 1. Pull the schedule_master row for PRUMC May 19 ---
console.log("=== schedule_master row 22e87613 ===");
const sm = await sb
  .from("schedule_master")
  .select("id, city, venue, mdapi_field_id, detail, match_date, match_time, max_spots")
  .eq("id", "22e87613-1b15-43aa-add4-f3e81cb40dd7")
  .maybeSingle();
if (sm.error || !sm.data) {
  console.log("FETCH ERROR or NOT FOUND:", sm.error);
  process.exit(1);
}
console.log(JSON.stringify(sm.data, null, 2));

// --- 2. Pull mdapi_matches row 14679 ---
console.log("\n=== mdapi_matches api_id 14679 ===");
const md = await sb
  .from("mdapi_matches")
  .select("api_id, city_identifier, field_id, field_title, start_date, is_cancelled, max_player_count, raw")
  .eq("api_id", 14679)
  .maybeSingle();
if (md.error || !md.data) {
  console.log("FETCH ERROR or NOT FOUND:", md.error);
  process.exit(1);
}
console.log({
  api_id: md.data.api_id,
  city_identifier: md.data.city_identifier,
  field_id: md.data.field_id,
  field_title: md.data.field_title,
  start_date: md.data.start_date,
  start_date_typeof: typeof md.data.start_date,
  is_cancelled: md.data.is_cancelled,
  raw_field_city_name: md.data.raw?.field?.city?.name,
});

// --- 3. Pull fin_venue_fields for 958 ---
console.log("\n=== fin_venue_fields where mdapi_field_id = 958 ===");
const vf = await sb
  .from("fin_venue_fields")
  .select("fin_venue_id, mdapi_field_id")
  .eq("mdapi_field_id", 958);
console.log(JSON.stringify(vf.data, null, 2));
const fieldIdToVenueId = new Map();
for (const row of vf.data ?? []) fieldIdToVenueId.set(row.mdapi_field_id, row.fin_venue_id);

// --- 4. Build venueNameToVenueId from fin_venues (for full coverage) ---
const fv = await sb.from("fin_venues").select("id, venue_name, city");
const venueNameToVenueId = new Map();
for (const v of fv.data ?? []) {
  const cityCode = normalizeCityName(v.city);
  if (!cityCode) continue;
  venueNameToVenueId.set(`${cityCode}|${v.venue_name.trim().toLowerCase()}`, v.id);
}
console.log("\n=== fin_venues rows with venue_name ILIKE 'PRUMC' ===");
const prumcRows = (fv.data ?? []).filter((v) => v.venue_name.toLowerCase().includes("prumc"));
console.log(JSON.stringify(prumcRows, null, 2));

// --- 5. Compute the schedule_master bucket key ---
console.log("\n=== Schedule_master indexing for 22e87613 ===");
const r = sm.data;
const sCityName = normalizeCityName(r.city);
console.log(`  r.city="${r.city}" → normalizeCityName → "${sCityName}"`);
console.log(`  r.mdapi_field_id=${r.mdapi_field_id}`);
let sVenueId = r.mdapi_field_id != null ? fieldIdToVenueId.get(r.mdapi_field_id) : undefined;
console.log(`  field_id path → fieldIdToVenueId.get(${r.mdapi_field_id}) = ${sVenueId}`);
if (sVenueId == null) {
  const fallbackKey = `${sCityName}|${r.venue.trim().toLowerCase()}`;
  sVenueId = venueNameToVenueId.get(fallbackKey);
  console.log(`  fallback string lookup "${fallbackKey}" → ${sVenueId}`);
}
const sHhmm = parseStartHHMM(r.match_time);
console.log(`  r.match_time="${r.match_time}" → parseStartHHMM → "${sHhmm}"`);
const sDate = r.match_date;
console.log(`  r.match_date="${sDate}"`);
const sKey = `${sCityName}|${sVenueId}|${sDate}|${sHhmm}`;
console.log(`  SCHEDULE_MASTER BUCKET KEY: "${sKey}"`);

// --- 6. Compute the mdapi bucket key ---
console.log("\n=== mdapi indexing for api_id 14679 ===");
const m = md.data;
const mCityName = matchCity(m);
console.log(`  raw.field.city.name="${m.raw?.field?.city?.name}", city_identifier="${m.city_identifier}" → matchCity → "${mCityName}"`);
const mVenueId = fieldIdToVenueId.get(m.field_id);
console.log(`  field_id=${m.field_id} → fieldIdToVenueId.get → ${mVenueId}`);
const ms = matchStart(m.start_date);
console.log(`  start_date="${m.start_date}" → matchStart → ${JSON.stringify(ms)}`);
const mKey = ms ? `${mCityName}|${mVenueId}|${ms.date}|${ms.hhmm}` : "NULL";
console.log(`  MDAPI BUCKET KEY: "${mKey}"`);

// --- 7. Verdict ---
console.log("\n=== Verdict ===");
console.log(`  schedule_master key : "${sKey}"`);
console.log(`  mdapi key           : "${mKey}"`);
console.log(`  MATCH? ${sKey === mKey ? "YES" : "NO"}`);

// --- 8. Also list all schedule_master rows for May 19 PRUMC (in case there are dupes) ---
console.log("\n=== All schedule_master rows for ATL/PRUMC on 2026-05-19 ===");
const allSm = await sb
  .from("schedule_master")
  .select("id, city, venue, mdapi_field_id, match_date, match_time, max_spots")
  .eq("match_date", "2026-05-19")
  .ilike("city", "Atlanta")
  .ilike("venue", "PRUMC");
console.log(JSON.stringify(allSm.data, null, 2));

// --- 9. Also list all mdapi_matches rows for PRUMC field_id 958 on May 19 ---
console.log("\n=== All mdapi_matches with field_id=958 on 2026-05-19 ===");
const allMd = await sb
  .from("mdapi_matches")
  .select("api_id, field_id, start_date, is_cancelled, city_identifier")
  .eq("field_id", 958)
  .gte("start_date", "2026-05-19T00:00:00Z")
  .lte("start_date", "2026-05-19T23:59:59Z");
console.log(JSON.stringify(allMd.data, null, 2));

import "server-only"; // no-op under --conditions=react-server
// PHASE 7 PART A - is startDate writable, and does endDate stay put?
// GET 2470, PUT startDate shifted EXACTLY ONE HOUR LATER and nothing else, GET
// again, diff every writable field. Answer: did startDateUtc follow by the
// field's offset, did endDate move/stay/invert, did anything else move. Restore.
// Single write, no retry (stageWrite enforces).
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/stage-p7-startdate.ts

import { stageGet, stageWrite } from "../src/lib/matchdayStageApi";
try { process.loadEnvFile(".env.local"); } catch {}

const ID = 2470;
const line = (s = "") => console.log(s);
const hr = () => line("-".repeat(72));
const get = () => stageGet<Record<string, unknown>>(`/admin/matches/${ID}`);
const SERVER_DERIVED = new Set(["updatedAt", "startDateUtc", "endDateUtc", "_count", "starRating", "starRatingCount"]);

// Shift the WALL-CLOCK hour by +1 on an ISO "...THH:mm:ss.sssZ" string WITHOUT
// ever constructing a Date (that would parse the Z as UTC and convert). Pure
// string surgery on the labelled hour; wraps 23->00 but does not roll the date
// (2470 is hour 20, no wrap). Returns the same shape the API returned.
function plusOneHourWallClock(iso: string): string {
  const m = iso.match(/^(\d{4}-\d{2}-\d{2}T)(\d{2})(:\d{2}:\d{2}(?:\.\d+)?Z)$/);
  if (!m) throw new Error(`unexpected date shape: ${JSON.stringify(iso)}`);
  const hh = (Number(m[2]) + 1) % 24;
  return `${m[1]}${String(hh).padStart(2, "0")}${m[3]}`;
}

// hours between two wall-clock ISO strings, read via getUTC* so the Z label is
// taken at face value (both are the SAME clock, so the offset cancels anyway).
function durationH(startIso: string, endIso: string): number {
  const s = Date.parse(startIso), e = Date.parse(endIso);
  return (e - s) / 3_600_000;
}

async function main() {
  hr(); line("(1) GET BEFORE"); hr();
  const BEFORE = await get();
  const startBefore = String(BEFORE.startDate);
  const shifted = plusOneHourWallClock(startBefore);
  line(`startDate    = ${startBefore}`);
  line(`startDateUtc = ${String(BEFORE.startDateUtc)}`);
  line(`endDate      = ${String(BEFORE.endDate)}`);
  line(`endDateUtc   = ${String(BEFORE.endDateUtc)}`);
  line(`-> will PUT startDate = ${shifted}  (exactly +1h wall clock, nothing else)`);

  line(); hr(); line("(2) PUT { startDate } only"); hr();
  await stageWrite("PUT", `/admin/matches/${ID}`, { startDate: shifted });
  line("PUT accepted (2xx).");

  const AFTER = await get();
  line(); hr(); line("(3) diff every key BEFORE vs AFTER, classified"); hr();
  const keys = [...new Set([...Object.keys(BEFORE), ...Object.keys(AFTER)])];
  const intended = new Set(["startDate"]);
  for (const k of keys) {
    if (JSON.stringify(BEFORE[k]) === JSON.stringify(AFTER[k])) continue;
    const cls = intended.has(k) ? "INTENDED" : SERVER_DERIVED.has(k) ? "SERVER-DERIVED" : "UNEXPECTED";
    line(`- ${k} [${cls}]`);
    line(`    BEFORE: ${JSON.stringify(BEFORE[k])}`);
    line(`    AFTER : ${JSON.stringify(AFTER[k])}`);
  }

  line(); hr(); line("(4) THE QUESTIONS, answered"); hr();
  const utcBefore = Date.parse(String(BEFORE.startDateUtc));
  const utcAfter = Date.parse(String(AFTER.startDateUtc));
  const utcDeltaH = (utcAfter - utcBefore) / 3_600_000;
  line(`Q: did startDateUtc follow startDate by exactly +1h?`);
  line(`   startDateUtc BEFORE ${String(BEFORE.startDateUtc)} -> AFTER ${String(AFTER.startDateUtc)}  (delta ${utcDeltaH}h)  => ${utcDeltaH === 1 ? "YES" : "NO"}`);
  const offBefore = (Date.parse(String(BEFORE.startDateUtc)) - Date.parse(startBefore)) / 3_600_000;
  const offAfter = (Date.parse(String(AFTER.startDateUtc)) - Date.parse(String(AFTER.startDate))) / 3_600_000;
  line(`   field offset (startDateUtc - startDate): BEFORE ${offBefore}h, AFTER ${offAfter}h  => ${offBefore === offAfter ? "PRESERVED" : "CHANGED"}`);

  const endMoved = JSON.stringify(BEFORE.endDate) !== JSON.stringify(AFTER.endDate);
  const endUtcMoved = JSON.stringify(BEFORE.endDateUtc) !== JSON.stringify(AFTER.endDateUtc);
  line(`Q: did endDate move? ${endMoved ? "YES" : "NO (stayed put)"}   endDateUtc move? ${endUtcMoved ? "YES" : "NO"}`);
  const durBefore = durationH(startBefore, String(BEFORE.endDate));
  const durAfter = durationH(String(AFTER.startDate), String(AFTER.endDate));
  line(`   duration BEFORE ${durBefore.toFixed(4)}h -> AFTER ${durAfter.toFixed(4)}h  ${durAfter < 0 ? "*** INVERTED ***" : durAfter < durBefore ? "(shortened - start moved toward end)" : ""}`);

  const otherMoved = keys.filter((k) => !intended.has(k) && !SERVER_DERIVED.has(k) && JSON.stringify(BEFORE[k]) !== JSON.stringify(AFTER[k]));
  line(`Q: did anything else move? ${otherMoved.length ? "YES: " + otherMoved.join(", ") : "NO"}`);

  line(); hr(); line("(5) restore startDate, confirm"); hr();
  await stageWrite("PUT", `/admin/matches/${ID}`, { startDate: startBefore });
  const FINAL = await get();
  const stillOff = keys.filter((k) => !SERVER_DERIVED.has(k) && JSON.stringify(BEFORE[k]) !== JSON.stringify(FINAL[k]));
  line(stillOff.length === 0
    ? `restored: startDate back to ${String(FINAL.startDate)}; every non-derived key matches BEFORE.`
    : `NOT fully restored - differ: ${stillOff.join(", ")}`);
  line("\nDONE.");
}
main().catch((e) => { console.error("FAILED:", e instanceof Error ? e.message : e); process.exit(1); });

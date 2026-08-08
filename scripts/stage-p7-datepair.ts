import "server-only"; // no-op under --conditions=react-server
// PHASE 7 PART A - prove the PAIR write (option a). Shift startDate AND endDate
// BOTH +1h, confirm both move, both *Utc follow, DURATION PRESERVED, nothing
// else moves. Restore. Evidence for lifting endDate off the deny-list.
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/stage-p7-datepair.ts

import { stageGet, stageWrite } from "../src/lib/matchdayStageApi";
try { process.loadEnvFile(".env.local"); } catch {}

const ID = 2470;
const line = (s = "") => console.log(s);
const hr = () => line("-".repeat(72));
const get = () => stageGet<Record<string, unknown>>(`/admin/matches/${ID}`);
const SERVER_DERIVED = new Set(["updatedAt", "startDateUtc", "endDateUtc", "_count", "starRating", "starRatingCount"]);

function plusOneHourWallClock(iso: string): string {
  const m = iso.match(/^(\d{4}-\d{2}-\d{2}T)(\d{2})(:\d{2}:\d{2}(?:\.\d+)?Z)$/);
  if (!m) throw new Error(`unexpected date shape: ${JSON.stringify(iso)}`);
  const hh = (Number(m[2]) + 1) % 24;
  return `${m[1]}${String(hh).padStart(2, "0")}${m[3]}`;
}
const durH = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 3_600_000;

async function main() {
  hr(); line("(1) GET BEFORE"); hr();
  const BEFORE = await get();
  const s0 = String(BEFORE.startDate), e0 = String(BEFORE.endDate);
  const s1 = plusOneHourWallClock(s0), e1 = plusOneHourWallClock(e0);
  line(`startDate ${s0} -> ${s1}`);
  line(`endDate   ${e0} -> ${e1}`);
  line(`duration BEFORE ${durH(s0, e0).toFixed(4)}h`);

  line(); hr(); line("(2) PUT { startDate, endDate } - both +1h"); hr();
  await stageWrite("PUT", `/admin/matches/${ID}`, { startDate: s1, endDate: e1 });
  line("PUT accepted (2xx).");

  const AFTER = await get();
  line(); hr(); line("(3) diff + answers"); hr();
  const keys = [...new Set([...Object.keys(BEFORE), ...Object.keys(AFTER)])];
  const intended = new Set(["startDate", "endDate"]);
  const other: string[] = [];
  for (const k of keys) {
    if (JSON.stringify(BEFORE[k]) === JSON.stringify(AFTER[k])) continue;
    const cls = intended.has(k) ? "INTENDED" : SERVER_DERIVED.has(k) ? "SERVER-DERIVED" : "UNEXPECTED";
    if (cls === "UNEXPECTED") other.push(k);
    line(`- ${k} [${cls}] ${JSON.stringify(BEFORE[k])} -> ${JSON.stringify(AFTER[k])}`);
  }
  const durAfter = durH(String(AFTER.startDate), String(AFTER.endDate));
  const sUtcD = (Date.parse(String(AFTER.startDateUtc)) - Date.parse(String(BEFORE.startDateUtc))) / 3_600_000;
  const eUtcD = (Date.parse(String(AFTER.endDateUtc)) - Date.parse(String(BEFORE.endDateUtc))) / 3_600_000;
  line();
  line(`startDateUtc followed +1h? ${sUtcD === 1 ? "YES" : "NO (" + sUtcD + "h)"}`);
  line(`endDateUtc   followed +1h? ${eUtcD === 1 ? "YES" : "NO (" + eUtcD + "h)"}`);
  line(`duration AFTER ${durAfter.toFixed(4)}h  => ${durAfter === durH(s0, e0) ? "PRESERVED" : "CHANGED"}`);
  line(`anything else move? ${other.length ? "YES: " + other.join(", ") : "NO"}`);

  line(); hr(); line("(4) restore both"); hr();
  await stageWrite("PUT", `/admin/matches/${ID}`, { startDate: s0, endDate: e0 });
  const FINAL = await get();
  const stillOff = keys.filter((k) => !SERVER_DERIVED.has(k) && JSON.stringify(BEFORE[k]) !== JSON.stringify(FINAL[k]));
  line(stillOff.length === 0 ? "restored: every non-derived key matches BEFORE." : `NOT restored: ${stillOff.join(", ")}`);
  line("\nDONE.");
}
main().catch((e) => { console.error("FAILED:", e instanceof Error ? e.message : e); process.exit(1); });

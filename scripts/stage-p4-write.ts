import "server-only"; // no-op under --conditions=react-server
// PART B - three-key write, but the BEFORE/AFTER diff runs over EVERY response
// key (read-only, modeled, unmodeled), not just the 23 the editor tracks.
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/stage-p4-write.ts

import { stageGet, stageWrite } from "../src/lib/matchdayStageApi";
try { process.loadEnvFile(".env.local"); } catch {}

const ID = 2470;
const line = (s = "") => console.log(s);
const hr = () => line("-".repeat(72));
const get = () => stageGet<Record<string, unknown>>(`/admin/matches/${ID}`);
// Fields the server legitimately recomputes on its own.
const SERVER_DERIVED = new Set(["updatedAt", "startDateUtc", "endDateUtc", "_count", "starRating", "starRatingCount"]);

async function main() {
  hr(); line("(1) GET BEFORE"); hr();
  const BEFORE = await get();
  const changes = { name: `${String(BEFORE.name)} [p4]`, guestCount: Number(BEFORE.guestCount) + 1, registrationPrice: Number(BEFORE.registrationPrice) + 1 };
  line(`name=${JSON.stringify(BEFORE.name)} guestCount=${BEFORE.guestCount} registrationPrice=${BEFORE.registrationPrice}`);

  line(); hr(); line("(2) PUT - exact body (3 keys)"); hr();
  line(JSON.stringify(changes, null, 2));
  await stageWrite("PUT", `/admin/matches/${ID}`, changes);
  line("PUT accepted (2xx).");

  const AFTER = await get();
  line(); hr(); line("(3/4) EVERY key where BEFORE differs from AFTER, classified"); hr();
  const keys = [...new Set([...Object.keys(BEFORE), ...Object.keys(AFTER)])];
  const intended = new Set(Object.keys(changes));
  const diffs: { k: string; cls: string }[] = [];
  for (const k of keys) {
    if (JSON.stringify(BEFORE[k]) === JSON.stringify(AFTER[k])) continue;
    const cls = intended.has(k) ? "INTENDED" : SERVER_DERIVED.has(k) ? "SERVER-DERIVED" : "UNEXPECTED";
    diffs.push({ k, cls });
    line(`- ${k} [${cls}]`);
    line(`    BEFORE: ${JSON.stringify(BEFORE[k])}`);
    line(`    AFTER : ${JSON.stringify(AFTER[k])}`);
  }
  const unexpected = diffs.filter((d) => d.cls === "UNEXPECTED");
  const derived = diffs.filter((d) => d.cls === "SERVER-DERIVED").map((d) => d.k);
  line();
  if (unexpected.length) {
    line(`*** UNEXPECTED (the finding): ${unexpected.map((d) => d.k).join(", ")} - STOPPING, not restoring. ***`);
    process.exit(1);
  }
  line(`no UNEXPECTED changes. INTENDED: ${diffs.filter((d) => d.cls === "INTENDED").map((d) => d.k).join(", ")}. SERVER-DERIVED that moved: ${derived.join(", ") || "none"}.`);

  line(); hr(); line("(5) restore the three fields, GET, confirm == BEFORE except server-derived"); hr();
  await stageWrite("PUT", `/admin/matches/${ID}`, { name: BEFORE.name, guestCount: BEFORE.guestCount, registrationPrice: BEFORE.registrationPrice });
  const FINAL = await get();
  const stillOff = keys.filter((k) => !SERVER_DERIVED.has(k) && JSON.stringify(BEFORE[k]) !== JSON.stringify(FINAL[k]));
  const derivedMoved = keys.filter((k) => SERVER_DERIVED.has(k) && JSON.stringify(BEFORE[k]) !== JSON.stringify(FINAL[k]));
  line(stillOff.length === 0
    ? `restored: every key matches BEFORE except server-derived (${derivedMoved.join(", ") || "none"}).`
    : `NOT fully restored - differ: ${stillOff.join(", ")}`);
  line("\nDONE.");
}
main().catch((e) => { console.error("FAILED:", e instanceof Error ? e.message : e); process.exit(1); });

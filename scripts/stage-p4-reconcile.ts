import "server-only"; // no-op under --conditions=react-server
// PART A - reconcile the writable set. Echo the full GET back as a PUT (it 400s,
// writing nothing), read the read-only set from the rejection, and classify every
// response key as READ-ONLY / MODELED / WRITABLE-BUT-UNMODELED.
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/stage-p4-reconcile.ts

import { stageSignInProbe, stageGet, assertStagingHost } from "../src/lib/matchdayStageApi";
import { EDITABLE_KEYS } from "../src/lib/matchEditModel";
try { process.loadEnvFile(".env.local"); } catch {}

const BASE = process.env.MATCHDAY_STAGE_API_BASE_URL as string;
const ID = 2470;
const url = new URL(`/admin/matches/${ID}`, BASE).toString();
const line = (s = "") => console.log(s);
const hr = () => line("-".repeat(72));
const READS: Record<string, string> = {
  teamHomeId: "id of the home team (result setup); null until teams are assigned",
  teamAwayId: "id of the away team (result setup); null until teams are assigned",
  teamHomeScore: "final score for the home side; null until played/entered",
  teamAwayScore: "final score for the away side; null until played/entered",
  startDate: "kickoff datetime; writable but deliberately unmodeled (own action, cascades to notifications/fake-spots/auto-cancel)",
  endDate: "match end datetime; writable but deliberately unmodeled (pairs with startDate)",
  maxPlayerCount: "capacity cap - total roster size the match allows",
  hasOrganizer: "whether the match has a designated organizer",
  teams: "the teams array; edited via the separate PUT /admin/teams/{id} endpoint",
};

async function main() {
  const probe = await stageSignInProbe();
  const TOKEN = probe.token;
  const get = () => stageGet<Record<string, unknown>>(`/admin/matches/${ID}`);

  const PRE = await get();
  hr(); line("(1) PUT full-echo -> expect 400 (writes nothing). Verbatim rejection:"); hr();
  assertStagingHost(url);
  const res = await fetch(url, { method: "PUT", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(PRE), signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  line(`HTTP ${res.status}`);
  line(text);

  const POST = await get();
  const drift = Object.keys(PRE).filter((k) => JSON.stringify(PRE[k]) !== JSON.stringify(POST[k]));
  line(); line(`match unchanged after the rejected echo? ${drift.length === 0 ? "YES (identical to pre-echo)" : "NO - moved: " + drift.join(", ")}`);

  // read-only set from the 400 message
  let rejected: string[] = [];
  try { rejected = (JSON.parse(text).message as string[]).map((m) => m.replace(/^property\s+/, "").replace(/\s+should not exist$/, "")); } catch { /* leave empty */ }
  const readonly = new Set(rejected);
  const modeled = new Set<string>(EDITABLE_KEYS);

  const keys = Object.keys(PRE);
  const writableUnmodeled: string[] = [];
  const pad = (s: string, n: number) => (s + " ".repeat(n)).slice(0, n);
  line(); hr(); line("(2) three-way classification of every response key"); hr();
  line(pad("KEY", 22) + pad("VALUE", 26) + "CLASS");
  for (const k of keys) {
    const cls = readonly.has(k) ? "READ-ONLY" : modeled.has(k) ? "MODELED" : "WRITABLE-BUT-UNMODELED";
    if (cls === "WRITABLE-BUT-UNMODELED") writableUnmodeled.push(k);
    const v = JSON.stringify(PRE[k]);
    line(pad(k, 22) + pad(v.length > 24 ? v.slice(0, 23) + "~" : v, 26) + cls);
  }
  line();
  line(`counts: READ-ONLY ${keys.filter((k) => readonly.has(k)).length}, MODELED ${keys.filter((k) => modeled.has(k)).length}, WRITABLE-BUT-UNMODELED ${writableUnmodeled.length}`);

  line(); hr(); line("(3) WRITABLE-BUT-UNMODELED inventory (no controls added)"); hr();
  for (const k of writableUnmodeled) {
    line(`- ${k} = ${JSON.stringify(PRE[k])}`);
    line(`    ${READS[k] ?? "(unknown - inspect)"}`);
  }
}
main().catch((e) => { console.error("FAILED:", e instanceof Error ? e.message : e); process.exit(1); });

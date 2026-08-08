import "server-only"; // no-op under --conditions=react-server
// PHASE 11 PART C - prove every editor-only field round-trips on ONE finished
// production match, ONE FIELD PER WRITE. For each: change it, read back all 54
// fields, confirm only that field + updatedAt moved, then restore (reconciling ANY
// unexpectedly-moved field back to BEFORE, so a cascade is both named AND undone).
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/prod-p11-roundtrip.ts
import { apiGet, apiWrite, WriteFailedError, AmbiguousWriteError } from "../src/lib/matchdayStageApi";
try { process.loadEnvFile(".env.local"); } catch {}

const ID = 17256;
const get = () => apiGet<Record<string, unknown>>("production", `/admin/matches/${ID}`);
const DERIVED = new Set(["updatedAt", "startDateUtc", "endDateUtc", "_count", "starRating", "starRatingCount"]);
const line = (s = "") => console.log(s);
const N = (c: unknown) => (Number(c) || 0);

// editor-only fields (EDITABLE_KEYS minus the 7 the drawer writes and minus the
// date pair), each with a plausible NEW value derived from the current one.
const FIELDS: { key: string; next: (c: unknown) => unknown }[] = [
  { key: "category", next: (c) => (c === "PREMIER" ? "OPEN" : "PREMIER") },
  { key: "type", next: (c) => (c === "EVENT" ? "REGULAR" : "EVENT") },
  { key: "description", next: (c) => `${String(c ?? "")} [p11]` },
  { key: "managerIntro", next: (c) => `${String(c ?? "")} [p11]` },
  { key: "minPlayerCount", next: (c) => N(c) + 1 },
  { key: "isFreeMember", next: (c) => !c },
  { key: "isAutoBump", next: (c) => !c },
  { key: "autoCanceled", next: (c) => !c },
  { key: "autoCanceledMinutes", next: (c) => N(c) + 1 },
  { key: "fakeSpotLeft36h", next: (c) => N(c) + 1 },
  { key: "fakeSpotLeft24h", next: (c) => N(c) + 1 },
  { key: "fakeSpotLeft12h", next: (c) => N(c) + 1 },
  { key: "fakeSpotLeft6h", next: (c) => N(c) + 1 },
  { key: "fakeSpotLeft3h", next: (c) => N(c) + 1 },
  { key: "maxTeamSize2Team", next: (c) => N(c) + 2 },
  { key: "maxTeamSize4Team", next: (c) => N(c) + 2 },
  { key: "maxPlayerCount", next: (c) => N(c) + 1 },
];

const short = (v: unknown) => { const s = JSON.stringify(v); return s && s.length > 22 ? s.slice(0, 21) + "…" : s; };

async function main() {
  line(`PART C — one-at-a-time production round-trip on finished match ${ID}\n`);
  const rows: string[] = [];
  const anomalies: string[] = [];
  for (const f of FIELDS) {
    const BEFORE = await get();
    const from = BEFORE[f.key];
    const to = f.next(from);
    let status = "", after = to, restored = "?", unexpected = "";
    try {
      await apiWrite("production", "PUT", `/admin/matches/${ID}`, { [f.key]: to });
    } catch (e) {
      if (e instanceof AmbiguousWriteError) { anomalies.push(`${f.key}: AMBIGUOUS write — stopping.`); rows.push(`${f.key.padEnd(20)} ${short(from)} -> (ambiguous) STOP`); break; }
      status = e instanceof WriteFailedError ? `rejected HTTP ${e.status}` : `err ${(e as Error).name}`;
      rows.push(`${f.key.padEnd(20)} ${String(short(from)).padEnd(24)} ${status}`);
      continue;
    }
    const AFTER = await get();
    after = AFTER[f.key];
    const moved = Object.keys({ ...BEFORE, ...AFTER }).filter((k) => !DERIVED.has(k) && JSON.stringify(BEFORE[k]) !== JSON.stringify(AFTER[k]));
    const extra = moved.filter((k) => k !== f.key);
    if (extra.length) { unexpected = extra.join(",") + " *** SIDE EFFECT ***"; anomalies.push(`${f.key} ALSO moved: ${extra.map((k) => `${k} ${short(BEFORE[k])}->${short(AFTER[k])}`).join("; ")}`); }
    // restore EVERYTHING that moved (the field + any cascade) back to BEFORE
    const restoreBody: Record<string, unknown> = {};
    for (const k of moved) restoreBody[k] = BEFORE[k];
    if (Object.keys(restoreBody).length) await apiWrite("production", "PUT", `/admin/matches/${ID}`, restoreBody);
    const FINAL = await get();
    const stillOff = Object.keys(BEFORE).filter((k) => !DERIVED.has(k) && JSON.stringify(BEFORE[k]) !== JSON.stringify(FINAL[k]));
    restored = stillOff.length === 0 ? "yes" : `NO(${stillOff.join(",")})`;
    rows.push(`${f.key.padEnd(20)} ${String(short(from)).padEnd(24)} ${String(short(after)).padEnd(24)} ${restored.padEnd(6)} ${unexpected || "only itself+updatedAt"}`);
  }

  line("field                before                   after                    restored  moved");
  line("-".repeat(110));
  rows.forEach((r) => line(r));
  line();
  if (anomalies.length) { line("ANOMALIES (fields that moved something other than themselves, or worse):"); anomalies.forEach((a) => line("  " + a)); }
  else line("No field moved anything other than itself + updatedAt. Every field restored.");
}
main().catch((e) => { console.error("FAILED:", e instanceof Error ? e.message.replace(/Body:.*/s, "Body:[omitted]") : e); process.exit(1); });

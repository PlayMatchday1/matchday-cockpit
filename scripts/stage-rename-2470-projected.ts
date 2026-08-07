import "server-only"; // no-op under --conditions=react-server
// Corrected write: PUT only the 31 writable-allowlist fields, name changed.
// Proves the projected read-modify-write before the UI touches it. Single-shot
// writes through the host-guarded staging client. Restores afterward.
//
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/stage-rename-2470-projected.ts

import { stageGet, stageWrite } from "../src/lib/matchdayStageApi";
try { process.loadEnvFile(".env.local"); } catch { /* env may already be present */ }

const ID = 2470;
const ORIGINAL = "Friendly match";
const RENAMED = "Friendly match [rename-test]";
const WRITABLE = [
  "name", "description", "teamHomeId", "teamAwayId", "teamHomeScore", "teamAwayScore",
  "type", "startDate", "endDate", "fieldId", "category", "minPlayerCount", "maxPlayerCount",
  "isFreeMember", "registrationPrice", "hasOrganizer", "managerIntro", "managerId",
  "secondManagerId", "guestCount", "autoCanceled", "autoCanceledMinutes", "maxTeamSize2Team",
  "maxTeamSize4Team", "isAutoBump", "additionalSpotPrice",
  "fakeSpotLeft36h", "fakeSpotLeft24h", "fakeSpotLeft12h", "fakeSpotLeft6h", "fakeSpotLeft3h",
  "teams",
];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const line = (s = "") => console.log(s);
const hr = () => line("─".repeat(72));
const project = (m: Record<string, unknown>) => Object.fromEntries(WRITABLE.filter((k) => k in m).map((k) => [k, m[k]]));

function diffFields(a: Record<string, unknown>, b: Record<string, unknown>) {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const rows: { k: string; from: unknown; to: unknown; nulled: boolean }[] = [];
  for (const k of keys) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) {
      const nulled = a[k] !== null && a[k] !== undefined && (b[k] === null || b[k] === undefined);
      rows.push({ k, from: a[k], to: b[k], nulled });
    }
  }
  return rows;
}
function reportDiff(rows: ReturnType<typeof diffFields>, ignore: string[]) {
  const findings = rows.filter((r) => !ignore.includes(r.k));
  for (const r of rows) {
    const tag = r.k === "name" ? "  (intended)"
      : r.k === "updatedAt" || r.k === "updated_at" ? "  (expected — write bumps it)"
      : r.nulled ? "  ← NON-NULL → NULL, FINDING" : "  ← UNEXPECTED, FINDING";
    line(`   • ${r.k}: ${JSON.stringify(r.from)} → ${JSON.stringify(r.to)}${tag}`);
  }
  return findings;
}

async function main() {
  // (a) GET full
  hr(); line("(a) GET /admin/matches/2470 — full object"); hr();
  const a = await stageGet<Record<string, unknown>>(`/admin/matches/${ID}`);
  line(JSON.stringify(a, null, 2));

  // (b) PUT projected (31 fields), name changed
  line(); hr(); line("(b) PUT — 31 writable fields only, name → rename-test"); hr();
  const body = { ...project(a), name: RENAMED };
  line(`sending ${Object.keys(body).length} fields: ${Object.keys(body).join(", ")}`);
  line("body:");
  line(JSON.stringify(body, null, 2));
  await stageWrite("PUT", `/admin/matches/${ID}`, body);
  line("PUT accepted (2xx).");

  line("\n… pausing 2s (refresh Retool now) …");
  await sleep(2000);

  // (c) GET, confirm, full diff vs (a)
  line(); hr(); line("(c) GET again — confirm + full diff vs (a)"); hr();
  const c = await stageGet<Record<string, unknown>>(`/admin/matches/${ID}`);
  line(`name: ${JSON.stringify(c.name)} → ${c.name === RENAMED ? "CHANGED ✓" : "MISMATCH ✗"}`);
  const cRows = diffFields(a, c);
  line(`fields that moved (${cRows.length}):`);
  const cFindings = reportDiff(cRows, ["name", "updatedAt", "updated_at"]);
  line(cFindings.length === 0
    ? "→ nothing moved beyond name + updatedAt. Projection is faithful."
    : `→ ${cFindings.length} UNEXPECTED change(s) above — projection sourced a field wrongly.`);

  // (d) PUT restore original name (from a's values)
  line(); hr(); line("(d) PUT — restore original name"); hr();
  await stageWrite("PUT", `/admin/matches/${ID}`, { ...project(a), name: ORIGINAL });
  line("restore accepted (2xx).");

  // (e) GET third time, confirm byte-identical to (a) except updatedAt
  line(); hr(); line("(e) GET final — confirm byte-identical to (a)"); hr();
  const e = await stageGet<Record<string, unknown>>(`/admin/matches/${ID}`);
  const eRows = diffFields(a, e);
  const eNonTime = eRows.filter((r) => r.k !== "updatedAt" && r.k !== "updated_at");
  if (eNonTime.length === 0) {
    line(`byte-identical to (a) across every field${eRows.length ? " except updatedAt (expected — two writes)" : ""}.`);
    for (const r of eRows) line(`   • ${r.k}: ${JSON.stringify(r.from)} → ${JSON.stringify(r.to)}  (expected)`);
  } else {
    line(`NOT fully restored — ${eNonTime.length} field(s) differ from (a):`);
    reportDiff(eRows, ["updatedAt", "updated_at"]);
  }
  line("\nDONE.");
}

main().catch((e) => { console.error("\nFAILED:", e instanceof Error ? `${e.name}: ${e.message}` : e); process.exit(1); });

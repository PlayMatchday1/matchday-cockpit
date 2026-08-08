import "server-only"; // no-op under --conditions=react-server
// PHASE 10 - READ-ONLY audit: how many matches in the CURRENT WEEK have caps
// inconsistent with any single per-team number (like 17256: 2-team total 0 but
// 4-team total 40). No write.
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/prod-p10-cap-audit.ts
import { apiGet } from "../src/lib/matchdayStageApi";
try { process.loadEnvFile(".env.local"); } catch {}

const FROM = "2026-08-03", TO = "2026-08-09"; // Mon..Sun of the week containing 2026-08-07
const numOrNull = (v: unknown) => { if (v === null || v === undefined || v === "") return null; const n = Number(v); return Number.isFinite(n) ? n : null; };

async function main() {
  const res = await apiGet<{ data?: Record<string, unknown>[] } | Record<string, unknown>[]>(
    "production", "/admin/matches", { limit: 500, page: 1, fromDate: FROM, toDate: TO, sortColumn: "startDate", sortDirection: "asc" },
  );
  const rows = Array.isArray(res) ? res : (res.data ?? []);
  console.log(`current-week matches returned by the list (${FROM}..${TO}): ${rows.length}`);
  let inconsistent = 0; const examples: string[] = [];
  for (const m of rows) {
    const teamCount = Array.isArray(m.teams) ? (m.teams as unknown[]).length : (numOrNull(m.teamNumbers) ?? 0);
    const mp2 = numOrNull(m.maxTeamSize2Team), mp4 = numOrNull(m.maxTeamSize4Team), mpc = numOrNull(m.maxPlayerCount);
    const cands: number[] = [];
    if (mp2 !== null) cands.push(mp2 / 2);
    if (mp4 !== null) cands.push(mp4 / 4);
    if (mpc !== null && teamCount > 0) cands.push(mpc / teamCount);
    const bad = new Set(cands).size > 1;
    if (bad) { inconsistent++; if (examples.length < 12) examples.push(`  id ${m.id}: 2team=${mp2} 4team=${mp4} cap=${mpc} teams=${teamCount} -> perTeam candidates ${[...new Set(cands)].join("/")}`); }
  }
  console.log(`INCONSISTENT caps: ${inconsistent} of ${rows.length}`);
  examples.forEach((e) => console.log(e));
}
main().catch((e) => { console.error("FAILED:", e instanceof Error ? e.message.replace(/Body:.*/s, "Body:[omitted]") : e); process.exit(1); });

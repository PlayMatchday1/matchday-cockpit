import "server-only"; // no-op under --conditions=react-server; blocks client bundling
// Phase 0 §4–6, staging only. Proves the staging credential, renames ONE match
// via a strict read-modify-write through the guarded write client, and (if a
// staging DB URL is present) cross-checks which columns the full-object PUT
// actually touched.
//
// Run:
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/stage-rename-match.ts
//
// Requires in .env.local: MATCHDAY_STAGE_API_BASE_URL / _EMAIL / _PASSWORD.
// Optional for the DB cross-check: MATCHDAY_STAGE_DATABASE_URL (+ `npm i -D pg`).
//
// The five fields UpdateMatchDto marks required — teams, teamHomeId, teamAwayId,
// teamHomeScore, teamAwayScore — are ECHOED verbatim. If ANY comes back null or
// undefined we REFUSE to PUT (throw) rather than substitute a default: a
// full-object PUT that omits a real score would null the scoreline.

import { stageSignInProbe, stageGet, stageWrite } from "../src/lib/matchdayStageApi";

try { process.loadEnvFile(".env.local"); } catch { /* env may already be in process.env */ }

const SUFFIX = " [rename-test]";
const REQ5 = ["teams", "teamHomeId", "teamAwayId", "teamHomeScore", "teamAwayScore"] as const;
type Match = Record<string, unknown> & { id: number; name: string };

function pickList(resp: unknown): Match[] {
  if (Array.isArray(resp)) return resp as Match[];
  const r = resp as Record<string, unknown>;
  return (r.data ?? r.items ?? r.results ?? []) as Match[];
}
function fiveOf(m: Record<string, unknown>) {
  return Object.fromEntries(REQ5.map((k) => [k, m[k]])) as Record<(typeof REQ5)[number], unknown>;
}
function requireFive(m: Record<string, unknown>, where: string) {
  const five = fiveOf(m);
  for (const k of REQ5) {
    if (five[k] === null || five[k] === undefined) {
      throw new Error(
        `REFUSING PUT: required field "${k}" came back ${JSON.stringify(five[k])} on ${where}. ` +
        `Not substituting a default — a full-object PUT without it would corrupt the match.`,
      );
    }
  }
  return five;
}
function jstr(v: unknown) { return JSON.stringify(v); }

// ── optional DB cross-check ──────────────────────────────────────────────────
async function dbSnapshot(matchId: number): Promise<{ table: string; row: Record<string, unknown> } | { skip: string }> {
  const url = process.env.MATCHDAY_STAGE_DATABASE_URL;
  if (!url) return { skip: "MATCHDAY_STAGE_DATABASE_URL not set — DB cross-check skipped" };
  let pg: { Client: new (cfg: unknown) => { connect(): Promise<void>; query(q: string, p?: unknown[]): Promise<{ rows: unknown[] }>; end(): Promise<void> } };
  // pg is an optional devDep; import by a computed specifier so tsc doesn't require its types.
  try { pg = (await import(/* @vite-ignore */ ["pg"].join(""))) as typeof pg; } catch { return { skip: "`pg` not installed — run `npm i -D pg` to enable the DB cross-check" }; }
  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    // Discover the match table: a table named like %match% that has this id.
    const cand = await client.query(
      `select table_name from information_schema.tables
        where table_schema='public' and table_type='BASE TABLE' and lower(table_name) like '%match%'
        order by (lower(table_name)='match') desc, (lower(table_name)='matches') desc, length(table_name) asc`,
    );
    for (const { table_name } of cand.rows as { table_name: string }[]) {
      try {
        const r = await client.query(`select * from "${table_name}" where id = $1 limit 1`, [matchId]);
        if (r.rows.length) return { table: table_name, row: r.rows[0] as Record<string, unknown> };
      } catch { /* wrong table shape — keep looking */ }
    }
    return { skip: `no %match% table held id=${matchId}; candidates: ${cand.rows.map((r: { table_name: string }) => r.table_name).join(", ")}` };
  } finally { await client.end(); }
}
function diffRows(before: Record<string, unknown>, after: Record<string, unknown>) {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const changed: string[] = [];
  for (const k of keys) {
    if (jstr(before[k]) !== jstr(after[k])) changed.push(`${k}: ${jstr(before[k])} → ${jstr(after[k])}`);
  }
  return changed;
}

async function main() {
  // ── 4. PROVE THE CREDENTIAL ────────────────────────────────────────────────
  console.log("── 4. staging sign-in ──");
  const probe = await stageSignInProbe();
  console.log(`AUTH OK. token.exp = ${probe.expMs ? new Date(probe.expMs).toISOString() : "(no exp claim)"} → ` +
    `${probe.minutesToExpiry != null ? probe.minutesToExpiry.toFixed(1) + " min from now" : "unknown lifetime"}`);

  // ── 5. SELECT A MATCH: ≥30d old, not cancelled, scores set, all 5 present ───
  console.log("\n── 5. select match ──");
  const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const list = await stageGet(`/admin/matches`, { isCancelled: false, startDateMax: cutoff, sortColumn: "startDate", sortDirection: "DESC", limit: 60, page: 1 });
  const items = pickList(list);
  console.log(`fetched ${items.length} candidates with startDate ≤ ${cutoff} (not cancelled)`);

  let chosen: Match | null = null;
  let detailA: Record<string, unknown> | null = null;
  let firstDetail: Record<string, unknown> | null = null;
  for (const it of items) {
    const d = await stageGet<Record<string, unknown>>(`/admin/matches/${it.id}`);
    if (!firstDetail) firstDetail = d;
    const missing = REQ5.filter((k) => d[k] === null || d[k] === undefined);
    const hasScore = (d.teamHomeScore != null || d.teamAwayScore != null) || (Array.isArray(d.goals) && d.goals.length > 0);
    if (missing.length === 0 && hasScore && d.isCancelled === false) { chosen = it; detailA = d; break; }
  }
  if (!chosen || !detailA) {
    console.log("\nNo candidate exposed all 5 required fields WITH scores. Raw shape of the newest candidate (for diagnosis):");
    console.log(jstr(firstDetail).slice(0, 1500));
    throw new Error("No suitable match: the GET does not return teamHomeScore/teamAwayScore for these matches, so a full-object PUT cannot echo them. This is a finding — report it; do not force the write.");
  }
  console.log(`CHOSEN match id=${chosen.id} — startDate=${detailA.startDate} (≥30d old), isCancelled=false, scores present, all 5 required fields non-null.`);

  // ── 5a. GET — print name + the five ─────────────────────────────────────────
  console.log("\n(a) GET before:");
  const a = await stageGet<Record<string, unknown>>(`/admin/matches/${chosen.id}`);
  const fiveA = requireFive(a, "GET(a)");
  console.log(`    name = ${jstr(a.name)}`);
  for (const k of REQ5) console.log(`    ${k} = ${jstr(fiveA[k])}`);

  // DB snapshot BEFORE the write
  const before = await dbSnapshot(chosen.id);
  if ("skip" in before) console.log(`\n[DB before] ${before.skip}`);
  else console.log(`\n[DB before] table "${before.table}", ${Object.keys(before.row).length} columns captured`);

  // ── 5b. PUT — echo the five verbatim, change only the name ───────────────────
  const newName = String(a.name) + SUFFIX;
  console.log(`\n(b) PUT: name ${jstr(a.name)} → ${jstr(newName)}, echoing the 5 required fields verbatim`);
  await stageWrite("PUT", `/admin/matches/${chosen.id}`, { ...fiveA, name: newName });
  console.log("    PUT accepted.");

  // ── 6. DB cross-check: snapshot AFTER, diff columns ─────────────────────────
  const after = await dbSnapshot(chosen.id);
  console.log("\n── 6. DB cross-check (what the PUT actually touched) ──");
  if ("skip" in after || "skip" in before) {
    console.log(`   skipped: ${"skip" in after ? after.skip : (before as { skip: string }).skip}`);
  } else {
    const cols = diffRows(before.row, after.row);
    console.log(`   columns changed by the PUT (table "${after.table}"):`);
    if (!cols.length) console.log("     (none — the row is byte-identical, unexpected for a rename)");
    for (const c of cols) console.log("     • " + c);
  }

  // ── 5c. GET — confirm name changed, five byte-identical ─────────────────────
  console.log("\n(c) GET after rename:");
  const c = await stageGet<Record<string, unknown>>(`/admin/matches/${chosen.id}`);
  console.log(`    name = ${jstr(c.name)}  (expected ${jstr(newName)}) → ${c.name === newName ? "OK" : "MISMATCH"}`);
  const fiveC = fiveOf(c);
  const drift = REQ5.filter((k) => jstr(fiveC[k]) !== jstr(fiveA[k]));
  console.log(`    5 required fields byte-identical to (a): ${drift.length === 0 ? "YES" : "NO — drifted: " + drift.join(", ")}`);

  // ── 5d. PUT — restore original name ─────────────────────────────────────────
  console.log(`\n(d) PUT: restore name → ${jstr(a.name)}`);
  await stageWrite("PUT", `/admin/matches/${chosen.id}`, { ...fiveA, name: a.name });
  console.log("    restored.");

  // ── 5e. GET — diff against (a) across EVERY field ───────────────────────────
  console.log("\n(e) GET final, full diff vs (a):");
  const e = await stageGet<Record<string, unknown>>(`/admin/matches/${chosen.id}`);
  const keys = [...new Set([...Object.keys(a), ...Object.keys(e)])].sort();
  const moved = keys.filter((k) => jstr(a[k]) !== jstr(e[k]));
  if (!moved.length) console.log("    identical across all fields (including updatedAt — noteworthy).");
  for (const k of moved) {
    const expected = k === "updatedAt" || k === "updated_at" ? "  (expected — write bumps it)" : "  ← UNEXPECTED, FINDING";
    console.log(`    • ${k}: ${jstr(a[k])} → ${jstr(e[k])}${expected}`);
  }
  console.log("\nDONE.");
}

main().catch((e) => { console.error("\nFAILED:", e instanceof Error ? `${e.name}: ${e.message}` : e); process.exit(1); });

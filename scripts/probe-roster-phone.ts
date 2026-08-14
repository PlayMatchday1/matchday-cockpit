// READ-ONLY probe for the match panel's roster work. Answers three questions before any code:
//   1. does GET /admin/matches/{id}/players carry a PHONE on p.user, and with what coverage
//   2. what order does the API return playerNumber in, per team (item 5's premise)
//   3. do duplicate playerNumbers occur on one team in real data
// No body is ever sent. Nothing identifying is printed — key NAMES and last-4 only.
//   npx tsx scripts/probe-roster-phone.ts
import { readFileSync } from "node:fs";
for (const line of readFileSync("/Users/ryanmancuso/Code/matchday-cockpit/.env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
import { apiGet } from "../src/lib/matchdayStageApi";
import { rosterRowCounts } from "../src/lib/gamedayModel";
async function main() {
  type Row = { id: number; team: number; playerNumber: number | null; user?: Record<string, unknown> };
  const rows = await apiGet<{ data?: Record<string, unknown>[] }>("production", "/admin/matches", { limit: 100, page: 1, sortColumn: "startDate", sortDirection: "asc" });
  const matches = (Array.isArray(rows) ? rows : (rows.data ?? [])) as Record<string, unknown>[];
  console.log(`matches read: ${matches.length}`);
  let seen = 0, phoneKey: string | null = null;
  let covHave = 0, covTotal = 0, shuffled = 0, teamsSeen = 0, nulls = 0, dupTeams = 0;
  let rawRows = 0, visRows = 0, realRows = 0, realWithPhone = 0, dupPairs = 0;
  for (const m of matches) {
    const pr = await apiGet<Row[] | { data?: Row[] }>("production", `/admin/matches/${m.id}/players`).catch(() => [] as Row[]);
    const allRows = (Array.isArray(pr) ? pr : (pr.data ?? [])) as Row[];
    // THE ROWS THE PANEL ACTUALLY RENDERS. Measuring on the raw payload overstates both the
    // shuffle and the duplicate rate, because the hidden WAITING retries carry spot numbers too.
    const pl = allRows.filter((p) => rosterRowCounts(p as never));
    rawRows += allRows.length; visRows += pl.length;
    const withUser = pl.find((p) => p.user);
    if (!withUser) continue;
    if (seen === 0) {
      console.log(`\nsample match ${m.id} — teams=${(m.teams as unknown[] ?? []).length} rows=${pl.length}`);
      console.log(`  ROW keys : ${Object.keys(withUser).join(", ")}`);
      console.log(`  user keys: ${Object.keys(withUser.user!).join(", ")}`);
      phoneKey = Object.keys(withUser.user!).find((k) => /phone|mobile|cell|^tel/i.test(k)) ?? null;
      console.log(`  PHONE KEY: ${phoneKey ?? "*** NONE — this payload carries no phone ***"}`);
      if (phoneKey) { const v = withUser.user![phoneKey]; console.log(`  sample   : ${v == null ? "null" : `type ${typeof v}, len ${String(v).length}, last4 ${String(v).slice(-4)}`}`); }
    }
    if (phoneKey) for (const p of pl) if (p.user) {
      covTotal++;
      const has = p.user[phoneKey] != null && String(p.user[phoneKey]).trim() !== "";
      if (has) covHave++;
      // fakes have no phone by construction — the number that matters is coverage among REAL players
      if (!p.user.isFakePlayer) { realRows++; if (has) realWithPhone++; }
    }
    const byTeam: Record<number, (number | null)[]> = {};
    for (const p of pl) (byTeam[p.team] ||= []).push(p.playerNumber);
    for (const ns of Object.values(byTeam)) {
      teamsSeen++;
      const nn = ns.filter((x) => x != null) as number[];
      nulls += ns.length - nn.length;
      if (nn.some((x, i) => i > 0 && x < nn[i - 1])) shuffled++;
      if (new Set(nn).size !== nn.length) { dupTeams++; dupPairs += nn.length - new Set(nn).size; }
    }
    if (seen < 4) { for (const [t, ns] of Object.entries(byTeam)) console.log(`  team ${t}: API order [${ns.join(",")}]`); }
    seen++;
  }
  console.log(`\n──────── over ${seen} matches, ${teamsSeen} teams ────────`);
  console.log(`phone key            : ${phoneKey ?? "NONE"}`);
  console.log(`rows: ${rawRows} raw -> ${visRows} rendered by the panel (rosterRowCounts)`);
  if (phoneKey) console.log(`phone coverage       : ${covHave}/${covTotal} rendered rows (${covTotal ? Math.round((covHave / covTotal) * 100) : 0}%) — REAL players only: ${realWithPhone}/${realRows} (${realRows ? Math.round((realWithPhone / realRows) * 100) : 0}%)`);
  console.log(`teams NOT in ascending playerNumber order: ${shuffled}/${teamsSeen} (${teamsSeen ? Math.round((shuffled / teamsSeen) * 100) : 0}%)`);
  console.log(`null playerNumber rows: ${nulls}`);
  console.log(`teams with a DUPLICATE playerNumber: ${dupTeams}/${teamsSeen} (${teamsSeen ? Math.round((dupTeams / teamsSeen) * 100) : 0}%), ${dupPairs} extra row(s) sharing a spot`);

}
main().catch((e) => { console.error(e); process.exit(1); });

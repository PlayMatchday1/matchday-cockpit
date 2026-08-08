import "server-only";
import { stageGet } from "../src/lib/matchdayStageApi";
try { process.loadEnvFile(".env.local"); } catch {}
const line = (s = "") => console.log(s);
const det = (id: number) => stageGet<Record<string, any>>(`/admin/matches/${id}`);
const durH = (a: string, b: string) => ((Date.parse(b) - Date.parse(a)) / 3600000);
const offH = (local: string, utc: string) => ((Date.parse(utc) - Date.parse(local)) / 3600000);
const roundMin = (iso: string) => { const d = new Date(iso); return d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0; };

async function show(m: Record<string, any>) {
  line(`--- id ${m.id}  "${m.name}"  [${m.type}/${m.category}]  players=${m._count?.players ?? "?"}  teams=${Array.isArray(m.teams) ? m.teams.length : "?"}`);
  line(`    startDate    = ${m.startDate}`);
  line(`    startDateUtc = ${m.startDateUtc}   (startDateUtc - startDate = ${offH(m.startDate, m.startDateUtc)}h)`);
  line(`    endDate      = ${m.endDate}`);
  line(`    endDateUtc   = ${m.endDateUtc}     (endDateUtc - endDate = ${offH(m.endDate, m.endDateUtc)}h)`);
  line(`    duration startDate->endDate = ${durH(m.startDate, m.endDate).toFixed(4)}h   start on round minute? ${roundMin(m.startDate)}`);
  line(`    maxPlayerCount=${m.maxPlayerCount}  maxTeamSize2Team=${m.maxTeamSize2Team}  maxTeamSize4Team=${m.maxTeamSize4Team}  minPlayerCount=${m.minPlayerCount}`);
}

async function main() {
  line("=== 2470 ==="); await show(await det(2470));
  line("\n=== other staging matches (most recent by startDate) ===");
  const list = await stageGet<any>(`/admin/matches`, { limit: 25, sortColumn: "startDate", sortDirection: "desc", page: 1 });
  const items = (list.data ?? list.items ?? list) as any[];
  // prefer real-looking rows: has players, or name lacks obvious test words
  const pick = items.filter((m) => m.id !== 2470).slice(0, 40);
  const chosen: any[] = [];
  for (const it of pick) {
    if (chosen.length >= 5) break;
    const d = await det(it.id);
    const real = (d._count?.players ?? 0) > 0 || roundMin(d.startDate);
    if (real) chosen.push(d);
  }
  if (chosen.length < 3) { // fall back: just show the first few regardless
    for (const it of pick.slice(0, 5)) if (chosen.length < 5) chosen.push(await det(it.id));
  }
  for (const m of chosen) { line(); await show(m); }
}
main().catch((e) => { console.error("FAILED:", e instanceof Error ? e.message : e); process.exit(1); });

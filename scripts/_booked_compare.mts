/* READ ONLY. bookedCount (cancelPatterns counts JOINED PLAYER ROWS) vs player_count (the API's
 * _count.players, which excludes WAITING and cancelled). Two sources for one figure. */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { mostRecentCompletedWeekMonday } from "../src/lib/weekWindow";
import { rosterRowCounts } from "../src/lib/gamedayModel";
const env = readFileSync("/Users/ryanmancuso/Code/matchday-cockpit/.env.local", "utf8");
const rd = (n: string) => env.match(new RegExp(`^${n}=(.+)$`, "m"))?.[1].trim().replace(/^['"]|['"]$/g, "") ?? "";
const sb = createClient(rd("NEXT_PUBLIC_SUPABASE_URL"), rd("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
async function all<T>(t: string, cols: string, q: (b: never) => never): Promise<T[]> {
  const out: T[] = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await (q(sb.from(t).select(cols).order("api_id").range(off, off + 999) as never) as unknown as PromiseLike<{ data: T[] | null; error: { message: string } | null }>);
    if (error) throw new Error(`${t}: ${error.message}`);
    out.push(...((data ?? []) as T[])); if ((data ?? []).length < 1000) break;
  }
  return out;
}
const now = new Date(), base = mostRecentCompletedWeekMonday(now);
const from = new Date(base.getFullYear(), base.getMonth(), base.getDate() - 21);
const to = new Date(base.getFullYear(), base.getMonth(), base.getDate() + 7);
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

type M = { api_id: number; field_title: string | null; start_date: string; is_cancelled: boolean | null; player_count: number | null };
const matches = await all<M>("mdapi_matches", "api_id, field_title, start_date, is_cancelled, player_count",
  (b) => (b as never as { gte: Function }).gte("start_date", ymd(from)) as never);
const inWindow = matches.filter((m) => m.start_date >= ymd(from) && m.start_date < ymd(to));
const cancelled = inWindow.filter((m) => m.is_cancelled === true);
console.log(`window ${ymd(from)} .. ${ymd(to)}:  ${inWindow.length} matches, ${cancelled.length} cancelled`);

const ids = cancelled.map((m) => m.api_id);
const players: { match_api_id: number; paid_status: string | null; is_cancelled: boolean | null }[] = [];
/* PAGED, PER BATCH. The first cut used .in(...).limit(50000) and got exactly 1000 rows back —
 * PostgREST's cap, which .limit() does not raise. It produced NEGATIVE gaps, which are impossible
 * (a joined-row count cannot be below _count.players), and that impossibility is what gave it
 * away. */
for (let i = 0; i < ids.length; i += 100) {
  const batch = ids.slice(i, i + 100);
  for (let off = 0; ; off += 1000) {
    const { data, error } = await sb.from("mdapi_match_players")
      .select("match_api_id, paid_status, is_cancelled").in("match_api_id", batch)
      .order("api_id").range(off, off + 999);
    if (error) throw new Error(`players: ${error.message}`);
    players.push(...(data ?? []) as typeof players);
    if ((data ?? []).length < 1000) break;
  }
}
console.log(`joined player rows on those cancelled matches: ${players.length}${players.length % 1000 === 0 ? "  <-- SUSPICIOUS ROUND MULTIPLE OF 1000" : ""}`);

let agree = 0; const diffs: { id: number; rows: number; count: number }[] = [];
for (const m of cancelled) {
  const mine = players.filter((p) => p.match_api_id === m.api_id);
  const joinedRows = mine.length;                       // what cancelPatterns' bookedCount counts
  const apiCount = m.player_count ?? 0;                 // what the match row says
  if (joinedRows === apiCount) agree++; else diffs.push({ id: m.api_id, rows: joinedRows, count: apiCount });
}
console.log(`\nCANCELLED MATCHES COMPARED: ${cancelled.length}`);
console.log(`  AGREE (joined rows == player_count):  ${agree}`);
console.log(`  DISAGREE:                             ${diffs.length}`);
if (diffs.length) {
  const gaps = diffs.map((d) => d.rows - d.count);
  const hist: Record<string, number> = {};
  for (const g of gaps) hist[g > 0 ? `+${g}` : String(g)] = (hist[g > 0 ? `+${g}` : String(g)] ?? 0) + 1;
  console.log(`  gap (joined rows minus player_count): min ${Math.min(...gaps)}  max ${Math.max(...gaps)}  total ${gaps.reduce((a, b) => a + b, 0)}`);
  console.log(`  distribution: ${JSON.stringify(hist)}`);
  for (const d of diffs.sort((a, b) => (b.rows - b.count) - (a.rows - a.count)).slice(0, 12)) {
    const mine = players.filter((p) => p.match_api_id === d.id);
    const rc = rosterRowCounts(mine.map((p) => ({ paidStatus: p.paid_status, isCancelled: p.is_cancelled })) as never);
    console.log(`     match ${d.id}: joined rows ${String(d.rows).padStart(3)}  player_count ${String(d.count).padStart(3)}  gap +${d.rows - d.count}   rosterRowCounts -> ${JSON.stringify(rc)}`);
  }
}
console.log(`\nCONTROL: cancelled matches with a non-zero player_count: ${cancelled.filter((m) => (m.player_count ?? 0) > 0).length} — an all-zero comparison would agree for free`);

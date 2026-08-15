// READ-ONLY. Why did only 603 of 1,416 excess redemptions price, and what is the MEASURED total?
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/probe-promo-excess-value.ts
import { readFileSync } from "node:fs";
for (const l of readFileSync("/Users/ryanmancuso/Code/matchday-cockpit/.env.local", "utf8").split("\n")) {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
import { createClient } from "@supabase/supabase-js";
import { apiGet } from "../src/lib/matchdayStageApi";
import { isFakePlayerEmail } from "../src/lib/mdapiFakePlayer";

const STAFF_CODE_IDS = new Set([104]);
type Row = { api_id: number; user_id: number | null; promocode_id: number; user_email: string | null;
  amount: number | null; match_api_id: number | null; user_is_fake_player: boolean | null; is_cancelled: boolean | null };

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  // ONE read, ORDERED. The previous pass paginated the SAME table twice with no ORDER BY; Postgres
  // is free to return a different page split each time, so the second read silently lost rows —
  // which is why 813 excess redemptions had no priced row to match. It was my pagination, not the
  // data. (Same defect the facts doc documents for the promo LIST endpoint.)
  // KEYSET pagination on the primary key: an OFFSET scan ordered by api_id times out (there is no
  // index on promocode_id, so Postgres sorts 237k rows for every page). Walking api_id forward
  // rides the PK index and is both fast AND stable — which is the actual fix, since instability
  // was the bug.
  const rows: Row[] = [];
  let cursor = 0;
  for (;;) {
    const { data, error } = await sb.from("mdapi_match_players")
      .select("api_id,user_id,promocode_id,user_email,amount,match_api_id,user_is_fake_player,is_cancelled")
      .not("promocode_id", "is", null)
      .gt("api_id", cursor)
      .order("api_id", { ascending: true })
      .limit(1000);
    if (error) throw new Error(error.message);
    const batch = (data ?? []) as Row[];
    if (!batch.length) break;
    rows.push(...batch);
    cursor = batch[batch.length - 1].api_id;
  }
  console.log(`redemption rows (ordered read): ${rows.length}`);

  const isStaff = (r: Row) => (!!r.user_email && (/@playmatchday\.com$/i.test(r.user_email) || isFakePlayerEmail(r.user_email))) || r.user_is_fake_player === true;
  const real = rows.filter((r) => !isStaff(r) && !STAFF_CODE_IDS.has(r.promocode_id) && r.user_id != null);
  console.log(`real-player redemptions: ${real.length}`);

  // caps
  const caps = new Map<number, { code: string; cap: number; scope: string; type: string; value: number }>();
  for (let page = 1; page <= 80; page++) {
    const r = await apiGet<{ data?: Record<string, unknown>[] }>("production", "/api/v1/admin/promocodes", { limit: 100, page });
    const list = (Array.isArray(r) ? r : (r.data ?? [])) as Record<string, unknown>[];
    if (!list.length) break;
    for (const p of list) caps.set(Number(p.id), { code: String(p.code), cap: Number(p.numberOfUsesPerUser) || 0,
      scope: String(p.targetMatchType), type: String(p.discountType), value: Number(p.discountValue) || 0 });
  }

  // group rows per (code,user) — from the SAME array, so nothing can drift
  const pair = new Map<string, Row[]>();
  for (const r of real) { const k = `${r.promocode_id}|${r.user_id}`; (pair.get(k) ?? pair.set(k, []).get(k)!).push(r); }

  const matchIds = [...new Set(real.map((r) => r.match_api_id).filter((x): x is number => x != null))];
  const price = new Map<number, { p: number; cancelled: boolean }>();
  for (let i = 0; i < matchIds.length; i += 500) {
    const { data } = await sb.from("mdapi_matches").select("api_id,registration_price,is_cancelled").in("api_id", matchIds.slice(i, i + 500));
    for (const m of data ?? []) price.set(m.api_id as number, { p: Number(m.registration_price) || 0, cancelled: !!m.is_cancelled });
  }

  let excessTotal = 0, worth = 0;
  const reason = { priced: 0, freeMatch: 0, cancelledMatch: 0, matchMissing: 0, noMatchId: 0 };
  for (const [k, rs] of pair) {
    const [cid] = k.split("|").map(Number);
    const c = caps.get(cid);
    if (!c || c.cap <= 0 || c.cap >= 10000 || c.scope === "TOTAL_USAGE") continue;
    const excess = rs.length - c.cap;
    if (excess <= 0) continue;
    excessTotal += excess;
    for (const r of rs.slice(0, excess)) {
      if (r.match_api_id == null) { reason.noMatchId++; continue; }
      const m = price.get(r.match_api_id);
      if (!m) { reason.matchMissing++; continue; }
      if (m.cancelled) { reason.cancelledMatch++; continue; }   // a cancelled match cost nothing
      if (m.p <= 0) { reason.freeMatch++; continue; }           // genuinely a $0 match
      reason.priced++;
      const paid = Number(r.amount) || 0;
      worth += c.type === "PERCENT" && c.value >= 100 ? m.p : Math.max(0, m.p - paid);
    }
  }
  console.log(`\nEXCESS redemptions beyond cap: ${excessTotal}`);
  console.log(`  priced                     : ${reason.priced}`);
  console.log(`  $0 / free-entry match      : ${reason.freeMatch}`);
  console.log(`  CANCELLED match (cost $0)  : ${reason.cancelledMatch}`);
  console.log(`  match not in the mirror    : ${reason.matchMissing}`);
  console.log(`  row carries no match id    : ${reason.noMatchId}`);
  console.log(`\nMEASURED VALUE OF THE EXCESS: $${(worth / 100).toFixed(2)}`);

  // ── THE BREACH HEADLINE, RE-DERIVED FROM THE STABLE READ ────────────────────────────────────
  // The earlier figures came from an UNSTABLE offset scan, which returns some rows twice and
  // skips others. The row TOTAL looked right, which is what made it convincing, but per-(code,
  // user) counts were inflated by the duplicates — so the breach numbers were too.
  const codes = new Set<number>(), players = new Set<number>();
  let pairs = 0, worstOver = 0; const worstCases: string[] = [];
  const dupCheck = new Set<number>(); let dupes = 0;
  for (const r of rows) { if (dupCheck.has(r.api_id)) dupes++; else dupCheck.add(r.api_id); }
  for (const [k, rs] of pair) {
    const [cid, uid] = k.split("|").map(Number);
    const c = caps.get(cid);
    if (!c || c.cap <= 0 || c.cap >= 10000 || c.scope === "TOTAL_USAGE") continue;
    if (rs.length > c.cap) {
      codes.add(cid); players.add(uid); pairs++;
      const over = rs.length - c.cap;
      if (over > worstOver) { worstOver = over; }
      if (over >= 3) worstCases.push(`${c.code} (${cid}) cap ${c.cap} — player ${uid} used it ${rs.length}x`);
    }
  }
  const redeemedCapped = new Set(real.map((r) => r.promocode_id).filter((id) => {
    const c = caps.get(id); return c && c.cap > 0 && c.cap < 10000 && c.scope !== "TOTAL_USAGE"; }));
  console.log(`\n──────── CORRECTED BREACH FIGURES (stable read) ────────`);
  console.log(`duplicate api_ids in this read           : ${dupes}  (0 = the read is sound)`);
  console.log(`codes with a real player over cap        : ${codes.size}`);
  console.log(`distinct real players over a cap         : ${players.size}`);
  console.log(`(code,player) pairs over cap             : ${pairs}`);
  console.log(`redeemed codes carrying a per-user cap   : ${redeemedCapped.size}`);
  console.log(`breach rate                              : ${redeemedCapped.size ? ((codes.size / redeemedCapped.size) * 100).toFixed(1) : 0}%`);
  console.log(`worst overage on one (code,player)       : +${worstOver}`);
  for (const w of worstCases.slice(0, 8)) console.log(`   ${w}`);
}
main().catch((e) => { console.error(e); process.exit(1); });

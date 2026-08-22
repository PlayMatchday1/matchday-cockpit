import { createClient } from "@supabase/supabase-js";
process.loadEnvFile(".env.local");
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const pageAll = async (t, sel, ord, f = q => q) => {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await f(db.from(t).select(sel)).order(ord).range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? [])); if ((data ?? []).length < 1000) break;
  }
  return out;
};
const now = new Date().toISOString();
console.log(`now = ${now}\n`);

// Matches in the current window that have NOT kicked off.
const ms = await pageAll("mdapi_matches", "api_id, start_date, start_date_utc, city_name, name, max_player_count",
  "api_id", q => q.gte("start_date", "2026-01-01").eq("is_cancelled", false).is("deleted_at", null));
const future = ms.filter(m => m.start_date_utc >= now);
const started = ms.filter(m => m.start_date_utc < now);
console.log(`matches since 2026-01-01: ${ms.length}   already kicked off: ${started.length}   NOT yet: ${future.length}`);

// Their registration revenue, by MATCH month (the breakdown's own attribution).
const futureIds = new Set(future.map(m => m.api_id));
const monthOf = new Map(ms.map(m => [m.api_id, String(m.start_date).slice(0, 7)]));
const regs = [];
for (let i = 0; i < ms.length; i += 40) {
  const chunk = ms.slice(i, i + 40).map(m => m.api_id);
  for (let from = 0; ; from += 1000) {
    const { data } = await db.from("mdapi_match_players")
      .select("match_api_id, amount, total_amount, paid_status, is_cancelled, refunded, deleted_at")
      .in("match_api_id", chunk).order("api_id").range(from, from + 999);
    if (!data?.length) break;
    regs.push(...data); if (data.length < 1000) break;
  }
}
const ok = (r) => !r.is_cancelled && r.refunded !== true && r.paid_status !== "WAITING" && r.deleted_at === null;
const byMonth = new Map();
for (const r of regs) {
  if (!ok(r)) continue;
  const m = monthOf.get(r.match_api_id); if (!m) continue;
  const b = byMonth.get(m) ?? { all: 0, futureRev: 0, futureN: new Set(), allN: new Set() };
  const amt = Number(r.amount ?? 0);
  b.all += amt; b.allN.add(r.match_api_id);
  if (futureIds.has(r.match_api_id)) { b.futureRev += amt; b.futureN.add(r.match_api_id); }
  byMonth.set(m, b);
}
console.log("\nmonth   matches  not-started  reg revenue (all)  ON NOT-STARTED   fin_revenue gross");
for (const [m, b] of [...byMonth.entries()].sort()) {
  const { data: fr } = await db.from("fin_revenue").select("gross").gte("date", `${m}-01`).lte("date", `${m}-31`).limit(1000);
  let gross = 0; for (let from = 0; ; from += 1000) {
    const { data } = await db.from("fin_revenue").select("gross").gte("date", `${m}-01`).lte("date", `${m}-31`).order("id", {ascending:true}).range(from, from+999);
    if (!data?.length) break; gross += data.reduce((a,r)=>a+Number(r.gross||0),0); if (data.length < 1000) break;
  }
  console.log(`${m}  ${String(b.allN.size).padStart(6)}  ${String(b.futureN.size).padStart(11)}  ${("$"+Math.round(b.all).toLocaleString()).padStart(17)}  ${("$"+Math.round(b.futureRev).toLocaleString()).padStart(14)}  ${("$"+Math.round(gross).toLocaleString()).padStart(17)}`);
}

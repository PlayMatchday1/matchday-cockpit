import { createClient } from "@supabase/supabase-js";
process.loadEnvFile(".env.local");
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const now = new Date().toISOString();
const pageAll = async (t, sel, ord, f = q => q) => {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await f(db.from(t).select(sel)).order(ord).range(from, from + 999);
    if (error) throw new Error(`${t}: ${error.message}`);
    out.push(...(data ?? [])); if ((data ?? []).length < 1000) break;
  }
  return out;
};
const ms = await pageAll("mdapi_matches", "api_id, start_date, start_date_utc", "api_id",
  q => q.gte("start_date", "2026-01-01").eq("is_cancelled", false).is("deleted_at", null));
const futureIds = new Set(ms.filter(m => m.start_date_utc >= now).map(m => m.api_id));
const monthOf = new Map(ms.map(m => [m.api_id, String(m.start_date).slice(0, 7)]));
const regs = [];
for (let i = 0; i < ms.length; i += 40) {
  const chunk = ms.slice(i, i + 40).map(m => m.api_id);
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("mdapi_match_players")
      .select("match_api_id, amount, paid_status, is_cancelled, refunded, deleted_at")
      .in("match_api_id", chunk).order("api_id").range(from, from + 999);
    if (error) throw new Error(error.message);
    if (!data?.length) break; regs.push(...data); if (data.length < 1000) break;
  }
}
const ok = r => !r.is_cancelled && r.refunded !== true && r.paid_status !== "WAITING" && r.deleted_at === null;
const by = new Map();
for (const r of regs) {
  if (!ok(r)) continue;
  const m = monthOf.get(r.match_api_id); if (!m) continue;
  const b = by.get(m) ?? { all: 0, fut: 0, allN: new Set(), futN: new Set() };
  const d = Number(r.amount ?? 0) / 100;                 // CENTS
  b.all += d; b.allN.add(r.match_api_id);
  if (futureIds.has(r.match_api_id)) { b.fut += d; b.futN.add(r.match_api_id); }
  by.set(m, b);
}
// fin_revenue by its OWN month column — no invented month-ends.
const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
// fin_revenue.month is "Aug 2026", not "2026-08". Joining on the raw string gave every month $0 —
// a clean-looking zero from a key that never matched.
const keyOf = (label) => { const [mo, yr] = String(label).split(" "); const i = MON.indexOf(mo);
  return i < 0 ? null : `${yr}-${String(i + 1).padStart(2, "0")}`; };
const fr = await pageAll("fin_revenue", "month, gross, type", "id");
const frBy = new Map();
for (const r of fr) { const k = keyOf(r.month); if (!k) continue; frBy.set(k, (frBy.get(k) ?? 0) + Number(r.gross ?? 0)); }
console.log("month   matches  not-started   registration rev   ON NOT-STARTED   fin_revenue(month)");
for (const [m, b] of [...by.entries()].sort()) {
  console.log(`${m}  ${String(b.allN.size).padStart(6)}  ${String(b.futN.size).padStart(11)}  ${("$"+Math.round(b.all).toLocaleString()).padStart(16)}  ${("$"+Math.round(b.fut).toLocaleString()).padStart(14)}  ${("$"+Math.round(frBy.get(m) ?? 0).toLocaleString()).padStart(17)}`);
}
console.log("\nfin_revenue month keys present:", JSON.stringify([...frBy.keys()].sort().slice(-8)));

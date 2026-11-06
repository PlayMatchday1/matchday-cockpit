// REBUILD fin_txn_daily BY HAND for a range older than the sync's 90-day backstop (see
// src/lib/finTxnDaily.ts), then compare every month's totals with fin_txn_sums, the function
// Finance > Revenue sums live. First run 2026-11-05 (Ryan approved): 2023-05-01 → today, 9,844 rows,
// all 43 months tied on gross, reversals, fees and net.
//   npx tsx scripts/fin-txn-daily-backfill.mts                     rebuild everything, then compare
//   npx tsx scripts/fin-txn-daily-backfill.mts 2025-01-01 2025-12-31   rebuild one range, then compare
//   npx tsx scripts/fin-txn-daily-backfill.mts compare             compare only, nothing written
// WRITES: refresh_fin_txn_daily deletes and re-inserts the rollup rows for the range. fin_txn is only
// read. Quarter by quarter so no single call runs long. Service role, from .env.local.
process.loadEnvFile(".env.local");
import { createClient } from "@supabase/supabase-js";
import { refreshFinTxnDaily, readFinTxnDaily } from "../src/lib/finTxnDaily";
import { totalsOf, RATES_FOR_SQL, type RollupRow } from "../src/lib/revenueTxn";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!.trim(), process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), { auth: { persistSession: false } });
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
const [argFrom, argTo] = process.argv.slice(2);

if (argFrom !== "compare") {
  const from = argFrom ?? "2023-05-01";
  const to = argTo ?? today;
  // quarter boundaries inside [from, to]
  const cuts: string[] = [from];
  for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y++)
    for (const m of ["01", "04", "07", "10"]) { const s = `${y}-${m}-01`; if (s > from && s <= to) cuts.push(s); }
  for (let i = 0; i < cuts.length; i++) {
    const a = cuts[i];
    const next = cuts[i + 1];
    const b = next ? new Date(new Date(next).getTime() - 86400000).toISOString().slice(0, 10) : to;
    const t0 = Date.now();
    const r = await refreshFinTxnDaily(sb, a, b);
    console.log(`refresh ${a}..${b}: ${r.ok ? `${r.rows} rows` : "ERROR " + r.error} (${Date.now() - t0} ms)`);
    if (!r.ok) process.exit(1);   // stop at the first error, no retry
  }
}

// compare monthly totals: daily table vs fin_txn_sums (what Finance > Revenue sums)
const daily = await readFinTxnDaily(sb);
const d = new Map<string, { gross: number; rev: number; tax: number; fee: number; net: number }>();
for (const r of daily) { const k = r.day.slice(0, 7); const e = d.get(k) ?? d.set(k, { gross: 0, rev: 0, tax: 0, fee: 0, net: 0 }).get(k)!; e.gross += Number(r.gross_cents); e.rev += Number(r.reversal_cents); e.tax += Number(r.tax_cents); e.fee += Number(r.fee_cents); e.net += Number(r.net_cents); }
const rows: RollupRow[] = [];
for (let off = 0; ; off += 1000) { const r = await sb.rpc("fin_txn_sums", { p_from: "2023-05-01", p_to: today, p_grain: "month", p_by_venue: false, p_venue_id: null, ...RATES_FOR_SQL }).range(off, off + 999); if (r.error) throw new Error(r.error.message); rows.push(...((r.data ?? []) as RollupRow[])); if ((r.data ?? []).length < 1000) break; }
const s = new Map<string, RollupRow[]>(); for (const r of rows) { const k = String(r.period).slice(0, 7); (s.get(k) ?? s.set(k, []).get(k)!).push(r); }
const months = [...new Set([...d.keys(), ...s.keys()])].sort();
const $ = (c: number) => (c / 100).toFixed(2);
let bad = 0;
console.log("month    | daily gross  sums gross | daily revers  sums revers | daily tax   sums tax  | daily fees  sums fees | daily net    sums net   | ok");
for (const m of months) {
  const a = d.get(m) ?? { gross: 0, rev: 0, tax: 0, fee: 0, net: 0 };
  const t = totalsOf(s.get(m) ?? []);
  const sumsRev = t.refundsGross + t.failedGross + t.disputesGross;   // tax in, at Stripe's amounts
  const sumsFees = (s.get(m) ?? []).filter((r) => !r.excluded).reduce((x, r) => x + r.fee_cents, 0);
  // tax is expected to differ by the tax inside reversals: the daily table carries it on every money
  // row, Finance's "Sales tax" line is charges only. gross, reversals, fees and net must tie.
  const diffs = [a.gross - t.gross, a.rev - sumsRev, a.fee - sumsFees, a.net - t.net];
  const ok = diffs.every((x) => Math.abs(x) <= 1);
  if (!ok) bad++;
  console.log(`${m} | ${$(a.gross).padStart(11)} ${$(t.gross).padStart(11)} | ${$(a.rev).padStart(11)} ${$(sumsRev).padStart(11)} | ${$(a.tax).padStart(10)} ${$(-t.tax).padStart(10)} | ${$(a.fee).padStart(10)} ${$(sumsFees).padStart(10)} | ${$(a.net).padStart(11)} ${$(t.net).padStart(11)} | ${ok ? "ok" : "OFF " + diffs.map($).join(",")}`);
}
console.log(`months compared: ${months.length} · off by more than a cent on gross/reversals/fees/net: ${bad}`);
process.exit(bad ? 1 : 0);

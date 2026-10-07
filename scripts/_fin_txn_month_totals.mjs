/* fin_txn MONTH TOTALS, CENTRAL TIME — the before/after check for the attribution re-run.
 *   node scripts/_fin_txn_month_totals.mjs snap <out.json>          save every month's totals
 *   node scripts/_fin_txn_month_totals.mjs diff <before.json> <after.json>
 * Stripe rows only (Venmo is loaded separately and compared on its own). Per month: rows and gross
 * for charge, refund, failed, dispute; Stripe's fee rows; the fee on every other row; and the
 * all-fees figure the tie-out uses (-(fee on rows) + fee rows). Integer cents throughout. */
import { readFileSync, writeFileSync } from "node:fs";
process.loadEnvFile(".env.local");
const { createClient } = await import("@supabase/supabase-js");
const [mode, a, b] = process.argv.slice(2);
const $ = (c) => (c / 100).toFixed(2);
const KEYS = ["charge", "refund", "failed", "dispute", "fee"];

if (mode === "snap") {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL.trim(), process.env.SUPABASE_SERVICE_ROLE_KEY.trim(), { auth: { persistSession: false } });
  const cm = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" });
  const out = {}; let n = 0;
  for (let last = 0; ;) {
    const { data, error } = await sb.from("fin_txn").select("id,kind,gross_cents,fee_cents,created_at_utc")
      .eq("source", "Stripe").gt("id", last).order("id").limit(1000);
    if (error) { console.log("READ FAILED:", error.message); process.exit(1); }
    for (const r of data) {
      const m = cm.format(new Date(r.created_at_utc)).slice(0, 7);
      const t = (out[m] ??= Object.fromEntries([...KEYS.flatMap((k) => [[`${k}_n`, 0], [`${k}_gross`, 0]]), ["fee_on_rows", 0]]));
      t[`${r.kind}_n`]++; t[`${r.kind}_gross`] += r.gross_cents;
      if (r.kind !== "fee") t.fee_on_rows += r.fee_cents;
    }
    n += data.length;
    if (data.length < 1000) break;
    last = data.at(-1).id;
  }
  for (const t of Object.values(out)) t.all_fees = -t.fee_on_rows + t.fee_gross;
  writeFileSync(a, JSON.stringify({ at: new Date().toISOString(), rows: n, months: out }, null, 1));
  console.log(`saved ${Object.keys(out).length} months, ${n} rows → ${a}`);
} else if (mode === "diff") {
  const A = JSON.parse(readFileSync(a, "utf8")), B = JSON.parse(readFileSync(b, "utf8"));
  console.log(`before ${A.at} (${A.rows} rows) · after ${B.at} (${B.rows} rows)`);
  console.log("month   │ charges gross            │ refunds   │ failed  │ disputes  │ all Stripe fees │ verdict");
  let moved = 0;
  for (const m of [...new Set([...Object.keys(A.months), ...Object.keys(B.months)])].sort()) {
    const x = A.months[m] ?? {}, y = B.months[m] ?? {};
    const fields = [...KEYS.flatMap((k) => [`${k}_n`, `${k}_gross`]), "fee_on_rows", "all_fees"];
    const diff = fields.filter((f) => (x[f] ?? 0) !== (y[f] ?? 0));
    if (diff.length) moved++;
    const cell = (f, w) => (x[f] === y[f] ? $(y[f] ?? 0) : `${$(x[f] ?? 0)}→${$(y[f] ?? 0)}`).padStart(w);
    console.log(`${m} │ ${cell("charge_gross", 24)} │ ${cell("refund_gross", 9)} │ ${cell("failed_gross", 7)} │ ${cell("dispute_gross", 9)} │ ${cell("all_fees", 15)} │ ${diff.length ? "** MOVED: " + diff.join(", ") + " **" : "identical"}`);
  }
  console.log(moved ? `\n** ${moved} MONTH(S) MOVED **` : "\nEVERY MONTH IDENTICAL TO THE CENT (rows and amounts, every kind)");
  process.exit(moved ? 1 : 0);
}

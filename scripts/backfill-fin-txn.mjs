/* THE BACK-FILL TRIGGER — walks months, one deployed call each.
 *
 *   node scripts/backfill-fin-txn.mjs --from 2025-04 --to 2026-10 [--base https://…] [--dry]
 *
 * ── WHY A WALKER AND NOT ONE BIG JOB ────────────────────────────────────────────────────────────
 * ~100,000 balance transactions at 100 per page with expand[]=data.source is ~1,000 sequential
 * Stripe calls — far past Vercel's 300s function ceiling. One month is ~60 calls and lands well
 * inside it, and a month is also the unit Ryan wants progress reported in.
 *
 * ── RE-RUNNING IS FREE ──────────────────────────────────────────────────────────────────────────
 * fin_txn upserts on balance_txn_id, so a month that half-finished can simply be run again. The
 * walker stops on the first failure rather than carrying on, because a gap in the middle of a
 * back-fill is far more expensive to find later than a stopped run is now.
 *
 * NEEDS CRON_SECRET in the environment to authenticate as the cron caller. It is read from the
 * env and never printed.
 */
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const BASE = arg("base", "https://matchday-clubhouse.vercel.app");
const DRY = process.argv.includes("--dry");
const from = arg("from"), to = arg("to");
if (!from || !to) { console.error("usage: --from YYYY-MM --to YYYY-MM"); process.exit(2); }
const secret = process.env.CRON_SECRET;
if (!secret && !DRY) { console.error("CRON_SECRET is not set in the environment"); process.exit(2); }

const months = [];
{
  let [y, m] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    months.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1; if (m > 12) { m = 1; y += 1; }
  }
}
console.log(`${months.length} months: ${months[0]} … ${months[months.length - 1]}${DRY ? "  (DRY RUN — no calls)" : ""}`);

let totalIns = 0, totalUpd = 0, totalFetched = 0;
const unmapped = new Set();
for (const month of months) {
  if (DRY) { console.log(`  ${month}  (dry)`); continue; }
  const t0 = Date.now();
  let res, j;
  try {
    res = await fetch(`${BASE}/api/sync/fin-txn?month=${month}`, {
      method: "POST", headers: { Authorization: `Bearer ${secret}` },
    });
    j = await res.json().catch(() => ({}));
  } catch (e) {
    console.error(`  ${month}  NETWORK FAILURE — ${e.message}. STOPPING.`); process.exit(1);
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  if (res.status === 409) { console.error(`  ${month}  BUSY — another sync is running. STOPPING.`); process.exit(1); }
  if (!res.ok || j?.outcome !== "LANDED") {
    console.error(`  ${month}  FAILED (${res.status}) — ${j?.error ?? "unknown"}. STOPPING.`); process.exit(1);
  }
  totalIns += j.inserted ?? 0; totalUpd += j.updated ?? 0; totalFetched += j.fetched ?? 0;
  for (const f of j.unmappedFieldIds ?? []) unmapped.add(f);
  console.log(`  ${month}  fetched ${String(j.fetched).padStart(6)}  inserted ${String(j.inserted).padStart(6)}  updated ${String(j.updated).padStart(5)}  ${secs}s`);
}
if (!DRY) {
  console.log(`\ntotal: ${totalFetched} fetched · ${totalIns} inserted · ${totalUpd} updated`);
  console.log(`unmapped fieldIds: ${unmapped.size ? [...unmapped].sort((a,b)=>a-b).join(", ") : "none"}`);
}

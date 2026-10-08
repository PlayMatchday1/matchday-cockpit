/* THE BACK-FILL TRIGGER — walks months, one deployed call each.
 *
 *   node scripts/backfill-fin-txn.mjs --from 2025-04 --to 2026-10 [--parts 3] [--base https://…] [--dry]
 *
 * ── EACH MONTH IN PIECES (--parts, default 3) ──────────────────────────────────────────────────
 * July 2026 took 296 s of the 300 s ceiling as one call once the membership email lookups were
 * added. A month is now run as `parts` calls, each a contiguous slice cut at Central midnights
 * (windowPart in src/lib/finTxnSync.ts) — about ten days, ~100 s for the busiest month so far.
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
 * ── AUTH: A SESSION TOKEN, NOT THE CRON SECRET ──────────────────────────────────────────────────
 * The route's manual mode takes a Supabase session and checks app_users fresh on every request.
 * That is the identity this walk should run under anyway — a back-fill is somebody doing something,
 * not the clock firing — and it means NO SECRET ON DISK. The token is minted from the e2e session
 * helper, held in memory, and never printed.
 */
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const BASE = arg("base", "https://matchday-clubhouse.vercel.app");
const DRY = process.argv.includes("--dry");
const from = arg("from"), to = arg("to");
const PARTS = Number(arg("parts", "3"));
if (!Number.isInteger(PARTS) || PARTS < 1 || PARTS > 10) { console.error("--parts must be 1..10"); process.exit(2); }
if (!from || !to) { console.error("usage: --from YYYY-MM --to YYYY-MM"); process.exit(2); }
const ADMIN = process.env.BACKFILL_AS || "rmancuso@playmatchday.com";
/* ── THE TOKEN IS MINTED PER MONTH, NOT ONCE ────────────────────────────────────────────────────
 * A Supabase access token lives about an hour and the full walk takes longer: minting once meant
 * 2025-06 onwards all failed `HTTP 401 — Not signed in`, fifteen months in a row, after the first
 * twenty-five had landed. sessionFor caches and VALIDATES against the server, so calling it every month
 * is nearly free and re-mints the moment the cached one stops being honoured. */
let sessionFor = null;
if (!DRY) {
  process.loadEnvFile(".env.local");
  ({ sessionFor } = await import("./e2e/_session.mjs"));
  console.log(`authenticating as ${ADMIN} (manual mode, session token minted per month — no secret on disk)`);
}
const freshToken = async () => (await sessionFor(ADMIN)).access_token;

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

let totalIns = 0, totalUpd = 0, totalFetched = 0, totalAttr = 0, totalUnlinked = 0;
const unmapped = new Set();
const failed = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ONE ATTEMPT. Returns the parsed body, or a reason. A 409 is "another run is in flight" and is
 * worth waiting out rather than counting as a failure — the walk is sequential, so the only thing
 * that produces one is a previous month whose log row has not closed yet. */
async function attempt(month, part) {
  let res, j;
  try {
    const token = await freshToken();
    res = await fetch(`${BASE}/api/sync/fin-txn?month=${month}&part=${part}&parts=${PARTS}`, {
      method: "POST", headers: { Authorization: `Bearer ${token}` },
    });
    j = await res.json().catch(() => ({}));
  } catch (e) { return { why: `network — ${e.message}` }; }
  if (res.status === 409) return { why: `busy (another sync started ${j.startedAt ?? "?"})`, busy: true };
  if (!res.ok || j?.outcome !== "LANDED") return { why: `HTTP ${res.status} — ${j?.error ?? "unknown"}` };
  return { j };
}

for (const month of months) {
  if (DRY) { console.log(`  ${month}  ×${PARTS} pieces`); continue; }
  for (let part = 1; part <= PARTS; part++) {
    const tag = PARTS > 1 ? `${month} ${part}/${PARTS}` : month;
    const t0 = Date.now();
    let r = await attempt(month, part);
    if (r.why) {
      // RETRY ONCE, as instructed. A busy route gets longer to clear than a hard failure does.
      console.log(`  ${tag}  first attempt failed (${r.why}) — retrying once`);
      await sleep(r.busy ? 45_000 : 5_000);
      r = await attempt(month, part);
    }
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    if (r.why) {
      // LOG IT AND CARRY ON. A stopped walk leaves a gap nobody can see later; a logged failure is
      // one line to re-run.
      console.log(`  ${tag}  ** FAILED ** ${r.why}   ${secs}s`);
      failed.push({ month: tag, why: r.why });
      continue;
    }
    const j = r.j;
    totalIns += j.inserted ?? 0; totalUpd += j.updated ?? 0; totalFetched += j.fetched ?? 0;
    const un = j.unmappedFieldIds ?? [];
    for (const f of un) unmapped.add(f);
    totalAttr += j.attributed ?? 0; totalUnlinked += j.reversalsUnlinked ?? 0;
    // "updated" = an AMOUNT or EXCLUSION moved (stamps updated_at); "attributed" = city/type/field/charge link only.
    console.log(`  ${tag.padEnd(11)}  fetched ${String(j.fetched).padStart(6)}  inserted ${String(j.inserted).padStart(6)}  updated ${String(j.updated).padStart(5)}  attributed ${String(j.attributed ?? "?").padStart(5)}  reversals unlinked ${j.reversalsUnlinked ?? "?"}  ${String(secs).padStart(4)}s${un.length ? `  unmapped fieldIds: ${un.join(", ")}` : ""}`);
  }
}

if (!DRY) {
  console.log(`\ntotal: ${totalFetched} fetched · ${totalIns} inserted · ${totalUpd} updated · ${totalAttr} attributed · ${totalUnlinked} reversals unlinked`);
  console.log(`unmapped fieldIds across the whole walk: ${unmapped.size ? [...unmapped].sort((a,b)=>a-b).join(", ") : "none"}`);
  console.log(failed.length
    ? `PIECES THAT FAILED TWICE (${failed.length}): ${failed.map((f) => `${f.month} (${f.why})`).join(" · ")}`
    : "no month failed");
}

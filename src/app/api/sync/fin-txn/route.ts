/* POST /api/sync/fin-txn — fill fin_txn from Stripe.
 *
 *   ?days=3            the hourly cron and the Sync now button
 *   ?days=60           the daily late-arrivals pass (disputes land weeks after the charge)
 *   ?month=2026-09     one month, for the historical back-fill
 *
 * ── IT NEVER TOUCHES fin_revenue AND IT NEVER DELETES ───────────────────────────────────────────
 * Upsert on balance_txn_id, nothing else. fin_revenue keeps its own nightly 06:00 Central job,
 * unchanged, and stays the live source for every Finance page until the switch.
 *
 * ── AUTH: THE SAME TWO MODES AS EVERY OTHER SYNC ROUTE ──────────────────────────────────────────
 *   cron    Bearer CRON_SECRET, constant-time compared, service-role client
 *   manual  Bearer <session token>, validated against Supabase, then an ADMIN CHECK
 * The Sync now button is manual mode. Ryan's ruling: gate it on the same admin session that guards
 * the Finance pages, no new permission column — so the check is adminAuth's, not a new one.
 *
 * ── OVERLAP ─────────────────────────────────────────────────────────────────────────────────────
 * A run in flight is visible in fin_sync_log as a row with started_at and no completed_at. A second
 * caller is refused with 409 rather than queued: two concurrent walks of the same window would both
 * succeed (the upsert makes them harmless) but would double the Stripe call volume for nothing, and
 * the button needs something true to say.
 */

import { timingSafeEqual } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { runWithLog, type TriggeredBy } from "@/lib/syncLogging";
import { syncFinTxn, finTxnLogPatch, windowDaysBack, windowForMonth } from "@/lib/finTxnSync";
import { recordWrite, supabaseLogStore } from "@/lib/changeLog";

/* 300s IS THE CEILING AND A MONTH IS THE UNIT. September alone is ~6,100 balance transactions at
 * 100 per page with `expand[]=data.source` — about 61 sequential Stripe calls. A 3-day window is a
 * handful. The back-fill walks months precisely so no single invocation approaches this. */
export const maxDuration = 300;
export const runtime = "nodejs";

const constantTimeMatch = (a: string, b: string) => {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
};

/** A run with no completed_at is still going. Older than an hour is a crash, not a run. */
async function runInFlight(sb: SupabaseClient): Promise<{ since: string } | null> {
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { data } = await sb.from("fin_sync_log")
    .select("started_at,completed_at")
    .in("source", ["stripe-txn", "stripe-txn-backfill"])
    .is("completed_at", null)
    .gte("started_at", hourAgo)
    .order("started_at", { ascending: false })
    .limit(1);
  const row = (data ?? [])[0];
  return row ? { since: String(row.started_at) } : null;
}

/* ── ONE HANDLER, THREE ENTRY POINTS ────────────────────────────────────────────────────────────
 * The two scheduled windows get their own route FILES rather than a query string on this one.
 * Vercel's docs allow `?days=3` in a cron path, but no cron in this project uses one and
 * cron-verb-test resolves every scheduled path to a route file on disk — it failed on exactly that,
 * which is the guard doing its job. A bare path is the house pattern and removes the question. */
export async function runFinTxnSync(req: Request, forced?: { days: number }) {
  const url = new URL(req.url);
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  const apiKey = process.env.STRIPE_SECRET_KEY?.trim();
  if (!supabaseUrl || !supabaseKey) return Response.json({ error: "Supabase env is not set" }, { status: 500 });
  if (!apiKey) return Response.json({ error: "STRIPE_SECRET_KEY is not set" }, { status: 500 });

  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return Response.json({ error: "Missing bearer token" }, { status: 401 });

  const cronSecret = process.env.CRON_SECRET;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  let triggeredBy: TriggeredBy;
  let supabase: SupabaseClient;
  let actor = "cron";

  if (cronSecret && constantTimeMatch(token, cronSecret)) {
    triggeredBy = "cron";
    if (!serviceKey) return Response.json({ error: "SUPABASE_SERVICE_ROLE_KEY is not set" }, { status: 500 });
    supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  } else {
    triggeredBy = "manual";
    const sessionClient = createClient(supabaseUrl, supabaseKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userData, error: userErr } = await sessionClient.auth.getUser(token);
    if (userErr || !userData?.user) return Response.json({ error: "Not signed in" }, { status: 401 });
    const email = userData.user.email ?? null;
    /* THE ADMIN CHECK, READ FRESH FROM THE DATABASE ON EVERY REQUEST — never from the JWT. This is
     * the Phase 17 rule and the reason there is no new permission column: app_users membership IS
     * the gate the Finance pages already use. select("*") deliberately, the adminAuth precedent:
     * naming a column that a pending migration has not added yet 500s the route. */
    if (!serviceKey) return Response.json({ error: "SUPABASE_SERVICE_ROLE_KEY is not set" }, { status: 500 });
    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: appUser } = await admin.from("app_users").select("*").eq("email", email ?? "").maybeSingle();
    if (!appUser) return Response.json({ error: "Not authorised" }, { status: 403 });
    actor = email ?? "unknown";
    supabase = admin;
  }

  // ── THE WINDOW ────────────────────────────────────────────────────────────────────────────────
  const monthParam = url.searchParams.get("month");
  let since: Date, until: Date, label: string;
  if (monthParam) {
    const m = /^(\d{4})-(\d{2})$/.exec(monthParam);
    if (!m) return Response.json({ error: "month must be YYYY-MM" }, { status: 400 });
    ({ since, until } = windowForMonth(Number(m[1]), Number(m[2])));
    label = monthParam;
  } else {
    const days = forced
      ? forced.days
      : Math.max(1, Math.min(400, Number(url.searchParams.get("days") ?? 3)));
    ({ since, until } = windowDaysBack(days));
    label = `last ${days} day${days === 1 ? "" : "s"}`;
  }
  const source = monthParam ? "stripe-txn-backfill" : "stripe-txn";

  const busy = await runInFlight(supabase);
  if (busy) {
    return Response.json(
      { error: "A sync is already running", startedAt: busy.since, outcome: "BUSY" },
      { status: 409 },
    );
  }

  const run = await runWithLog(source, triggeredBy, supabase, (sb) =>
    syncFinTxn(sb, { since, until, apiKey }), finTxnLogPatch);

  if (!run.ok) return Response.json({ error: run.error, outcome: "FAILED" }, { status: 500 });

  /* ── change_log, FOR THE MANUAL RUNS ONLY ────────────────────────────────────────────────────
   * Ryan: log who clicked it. A cron has no actor, and 24 rows a day of "the clock fired" is noise
   * in a log whose job is to say who changed what. NEVER THE ROW BODIES — a fin_txn row carries a
   * charge description and a customer's charge id, which is a second copy of payment data under
   * different access rules. Counts and the window only. */
  if (triggeredBy === "manual") {
    const r = run.result;
    await recordWrite(
      {
        env: "prod", source: "fin-txn-sync", actorName: actor, actorEmail: actor,
        saveId: `fin-txn-${Date.now()}`, matchId: null,
        method: "POST", path: new URL(req.url).pathname,
        // COUNTS AND THE WINDOW, NEVER THE ROWS. A fin_txn row carries a charge description and a
        // Stripe charge id — payment data under different access rules from this log.
        body: { window: label, since: since.toISOString(), until: until.toISOString() },
        keys: [], label: (k) => k,
        applied: () => true,
        changes: [{
          key: "fin_txn",
          field: "fin_txn",
          before: "",
          after: `${r.inserted} inserted, ${r.updated} updated, ${r.fetched} fetched (${label})`,
        }],
      },
      {
        readResource: async () => ({}),
        write: async () => r,
        now: () => new Date().toISOString(),
      },
      // THE HOUSE STORE, service-role, same as every other write that lands in change_log.
      supabaseLogStore(),
    ).catch(() => {});
  }

  return Response.json({ outcome: "LANDED", source, window: label, triggeredBy, ...run.result });
}

/** Manual calls and the back-fill walker: ?days=N or ?month=YYYY-MM. */
export async function POST(req: Request) {
  return runFinTxnSync(req);
}

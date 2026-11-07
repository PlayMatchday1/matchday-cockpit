/* POST /api/sync/stripe-people: who paid (migration 0236, lib/stripePeopleSync).
 *
 *   ?job=customers|invoices|charges&month=2026-09   one Central month, for the back-fill
 *   ?job=customers|invoices&days=3                  a recent window
 *   ?job=unpaid&month=2026-09 | &days=3             unpaid membership invoices (0262): every open one,
 *                                                   uncollectible and void ones in the window
 *   ?job=sub-ends&limit=600                         Stripe's end date per CANCELED membership (0261,
 *                                                   lib/stripeSubEnds): paced, no retries, first error
 *                                                   stops; run again until `remaining` is 0
 *
 * AUTH IS fin-txn's: Bearer CRON_SECRET (service role), or a signed-in session whose email is in
 * app_users, read fresh. Every Stripe call is a GET. The two tables it writes are service role only,
 * so the browser never reads an email; this route answers with counts, never rows. */
import { timingSafeEqual } from "node:crypto";
import Stripe from "stripe";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { runWithLog, type TriggeredBy } from "@/lib/syncLogging";
import { windowDaysBack, windowForMonth } from "@/lib/finTxnSync";
import { backfillChargeCustomers, peopleLogPatch, syncMemberInvoices, syncStripeCustomers, syncUnpaidInvoices, type PeopleJob } from "@/lib/stripePeopleSync";
import { recordWrite, supabaseLogStore } from "@/lib/changeLog";
import { syncSubEnds, subEndsLogPatch } from "@/lib/stripeSubEnds";
import { refuseUnlessAdmin } from "@/lib/adminSession";

export const maxDuration = 300;
export const runtime = "nodejs";

const constantTimeMatch = (a: string, b: string) => {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
};

export async function runStripePeopleSync(req: Request, forced?: { jobs: PeopleJob[]; days: number } | { subEnds: { limit: number } }) {
  const url = new URL(req.url);
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const apiKey = process.env.STRIPE_SECRET_KEY?.trim();
  if (!supabaseUrl || !supabaseKey || !serviceKey) return Response.json({ error: "Supabase env is not set" }, { status: 500 });
  if (!apiKey) return Response.json({ error: "STRIPE_SECRET_KEY is not set" }, { status: 500 });
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return Response.json({ error: "Missing bearer token" }, { status: 401 });

  const admin: SupabaseClient = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  let triggeredBy: TriggeredBy = "cron";
  let actor = "cron";
  const cronSecret = process.env.CRON_SECRET;
  if (!(cronSecret && constantTimeMatch(token, cronSecret))) {
    triggeredBy = "manual";
    const sessionClient = createClient(supabaseUrl, supabaseKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userData, error: userErr } = await sessionClient.auth.getUser(token);
    if (userErr || !userData?.user) return Response.json({ error: "Not signed in" }, { status: 401 });
    const adminRefusal = await refuseUnlessAdmin(userData.user.email);
    if (adminRefusal) return adminRefusal;
    // select("*") deliberately, the adminAuth precedent. Read fresh on every request.
    const { data: appUser } = await admin.from("app_users").select("*").eq("email", userData.user.email ?? "").maybeSingle();
    if (!appUser) return Response.json({ error: "Not authorised" }, { status: 403 });
    actor = userData.user.email ?? "unknown";
  }

  /* STRIPE END DATES (0261). Its own branch: no window, a row budget instead. The client has NO network
   * retries — the first failure stops the run and the next run resumes where it stopped. */
  const subEndsLimit = forced && "subEnds" in forced ? forced.subEnds.limit
    : url.searchParams.get("job") === "sub-ends" ? Math.max(1, Math.min(800, Number(url.searchParams.get("limit") ?? 300) || 300)) : null;
  if (subEndsLimit != null) {
    const once = new Stripe(apiKey, { maxNetworkRetries: 0 });
    const run = await runWithLog("stripe-sub-ends", triggeredBy, admin, (sb) => syncSubEnds(sb, once, { limit: subEndsLimit }), subEndsLogPatch);
    if (!run.ok) return Response.json({ error: run.error, job: "sub-ends", outcome: "FAILED" }, { status: 500 });
    const r = run.result;
    if (triggeredBy === "manual") {
      await recordWrite(
        {
          env: "prod", source: "stripe-people-sync", actorName: actor, actorEmail: actor,
          saveId: `stripe-sub-ends-${Date.now()}`, matchId: null,
          method: "POST", path: url.pathname,
          body: { job: "sub-ends", limit: subEndsLimit },
          keys: [], label: (k) => k,
          applied: () => true,
          changes: [{ key: "sub-ends", field: "sub-ends", before: "", after: `${r.asked} asked, ${r.written} written, ${r.remaining} left${r.stoppedOn ? `, stopped: ${r.stoppedOn}` : ""}` }],
        },
        { readResource: async () => ({}), write: async () => r, now: () => new Date().toISOString() },
        supabaseLogStore(),
      ).catch(() => {});
    }
    return Response.json({ outcome: r.stoppedOn ? "STOPPED" : "LANDED", triggeredBy, results: [r] }, { status: r.stoppedOn ? 502 : 200 });
  }

  let jobs: PeopleJob[];
  let w: { since: Date; until: Date };
  let label: string;
  if (forced && "jobs" in forced) {
    jobs = forced.jobs; w = windowDaysBack(forced.days); label = `last ${forced.days} days`;
  } else {
    const job = url.searchParams.get("job");
    if (job !== "customers" && job !== "invoices" && job !== "charges" && job !== "unpaid") return Response.json({ error: "job must be customers, invoices, charges, unpaid or sub-ends" }, { status: 400 });
    jobs = [job];
    const month = url.searchParams.get("month");
    if (month) {
      const m = /^(\d{4})-(\d{2})$/.exec(month);
      if (!m) return Response.json({ error: "month must be YYYY-MM" }, { status: 400 });
      w = windowForMonth(Number(m[1]), Number(m[2])); label = month;
    } else {
      const days = Math.max(1, Math.min(60, Number(url.searchParams.get("days") ?? 3)));
      w = windowDaysBack(days); label = `last ${days} days`;
    }
  }

  const stripe = new Stripe(apiKey, { maxNetworkRetries: 4 });
  const results = [];
  for (const job of jobs) {
    const source = job === "invoices" ? "stripe-member-invoices" : job === "unpaid" ? "stripe-member-unpaid-invoices" : "stripe-customers";
    const run = await runWithLog(source, triggeredBy, admin, (sb) =>
      job === "customers" ? syncStripeCustomers(sb, stripe, w)
        : job === "invoices" ? syncMemberInvoices(sb, stripe, w)
        : job === "unpaid" ? syncUnpaidInvoices(sb, stripe, w)
        : backfillChargeCustomers(sb, stripe, w), peopleLogPatch);
    if (!run.ok) return Response.json({ error: run.error, job, outcome: "FAILED", done: results }, { status: 500 });
    results.push(run.result);
    // change_log for manual runs: who ran it, the window and the counts. Never a row: rows hold emails.
    if (triggeredBy === "manual") {
      const r = run.result;
      await recordWrite(
        {
          env: "prod", source: "stripe-people-sync", actorName: actor, actorEmail: actor,
          saveId: `stripe-people-${job}-${Date.now()}`, matchId: null,
          method: "POST", path: url.pathname,
          body: { job, window: label, since: r.sinceIso, until: r.untilIso },
          keys: [], label: (k) => k,
          applied: () => true,
          changes: [{ key: job, field: job, before: "", after: `${r.fetched} fetched, ${r.written} written, ${r.extra} extra (${label})` }],
        },
        { readResource: async () => ({}), write: async () => r, now: () => new Date().toISOString() },
        supabaseLogStore(),
      ).catch(() => {});
    }
  }
  return Response.json({ outcome: "LANDED", window: label, triggeredBy, results });
}

export async function POST(req: Request) {
  return runStripePeopleSync(req);
}

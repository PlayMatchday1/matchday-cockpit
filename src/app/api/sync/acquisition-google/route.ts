// POST|GET /api/sync/acquisition-google — the Acquisition page's three Google syncs, daily.
//
//   gsc-pages  Search Console by page and day       → acq_gsc_page_daily
//   ga4-web    website traffic and store clicks      → acq_web_page_daily, acq_web_store_click_daily
//   ga4-app    app first opens by platform / source  → acq_app_event_daily
//
// READ-ONLY AGAINST GOOGLE (lib/acqGoogleSync). Each source is its own fin_sync_log row, so one
// failing never hides the other two. A scheduled run re-reads the trailing ACQ_TRAILING_DAYS; a
// MANUAL run (a signed-in session) may pass { since, until } to backfill, clamped to Jul 1, 2026.
// Same dual-mode auth as the other sync routes: CRON_SECRET for the scheduled call, a valid
// session for a manual one. Writes use the service role.

import { timingSafeEqual } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { runWithLog, type SourceName, type TriggeredBy } from "@/lib/syncLogging";
import { ACQ_FLOOR, ACQ_TRAILING_DAYS, googleAnalyticsToken, syncGa4App, syncGa4Web, syncGsc } from "@/lib/acqGoogleSync";

export const maxDuration = 300;
export const runtime = "nodejs";

function constantTimeMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8"), bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
const chicagoToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
const minusDays = (ymd: string, n: number) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
const YMD = /^\d{4}-\d{2}-\d{2}$/;

export async function POST(req: Request) {
  const startedAt = Date.now();
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) return Response.json({ error: "Missing Authorization header" }, { status: 401 });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const anon = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !anon || !service) return Response.json({ error: "Supabase env not configured" }, { status: 500 });

  const cronSecret = process.env.CRON_SECRET;
  let triggeredBy: TriggeredBy;
  if (cronSecret && constantTimeMatch(token, cronSecret)) triggeredBy = "cron";
  else {
    const s = createClient(url, anon, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await s.auth.getUser(token);
    if (error || !data?.user) return Response.json({ error: "Invalid session" }, { status: 401 });
    triggeredBy = "manual";
  }
  const sb: SupabaseClient = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });

  // THE WINDOW. Cron always gets the trailing window; only a manual run may name one (the cron path
  // sends no body, and keying on the trigger means a change to how cron is invoked cannot hand it one).
  const today = chicagoToday();
  let since = minusDays(today, ACQ_TRAILING_DAYS), until = today;
  if (triggeredBy === "manual") {
    let body: { since?: unknown; until?: unknown } = {};
    try { body = (await req.json()) as typeof body; } catch { /* no body */ }
    if (typeof body.since === "string" && YMD.test(body.since)) since = body.since;
    if (typeof body.until === "string" && YMD.test(body.until)) until = body.until;
  }
  if (since < ACQ_FLOOR) since = ACQ_FLOOR;
  if (until > today) until = today;
  if (until < since) return Response.json({ error: "until is before since" }, { status: 400 });

  let gToken: string;
  try { gToken = await googleAnalyticsToken(); }
  catch (e) { return Response.json({ error: e instanceof Error ? e.message : "Google token failed" }, { status: 500 }); }

  const steps: [SourceName, () => Promise<Record<string, number>>, (r: Record<string, number>) => number][] = [
    ["gsc-pages", () => syncGsc(sb, gToken, since, until), (r) => r.rows],
    ["ga4-web", () => syncGa4Web(sb, gToken, since, until), (r) => r.pageRows + r.clickRows],
    ["ga4-app", () => syncGa4App(sb, gToken, since, until), (r) => r.rows],
  ];
  const results: Record<string, unknown> = {};
  let anyFailed = false;
  for (const [source, fn, count] of steps) {
    const r = await runWithLog(source, triggeredBy, sb, () => fn(), (x) => ({ rows_imported: count(x) }));
    if (!r.ok) anyFailed = true;
    results[source] = r;
  }
  return Response.json({ triggeredBy, since, until, durationMs: Date.now() - startedAt, results }, { status: anyFailed ? 500 : 200 });
}

// Vercel cron sends GET (see /api/sync/meta-ad-spend for the night that was learned).
export const GET = POST;

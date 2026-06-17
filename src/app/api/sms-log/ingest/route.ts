// POST /api/sms-log/ingest — on-demand "fetch recent" trigger for the
// /sms-log dashboard. Admin-only. Pulls the last N hours of outbound
// Telnyx SMS into telnyx_sms_log so an operator can see today's sends
// without waiting for the daily cron.
//
// Query param: ?hours=N (default 24, clamped 1..168). The daily cron
// (/api/sync/cron) owns the routine 2-day backfill; this is the manual
// catch-up.
//
// Auth: admin session via authenticateCrm. telnyx_sms_log RLS only
// grants SELECT to authenticated, so the ingest's upsert/prune must run
// with the service role — we build a service client here after the
// admin check (same write path as the cron's service-role client).

import { createClient } from "@supabase/supabase-js";
import { authenticateCrm } from "@/lib/crmAuth";
import { ingestTelnyxSms } from "@/lib/telnyxSmsIngest";

export const runtime = "nodejs";
export const maxDuration = 60;

const DEFAULT_HOURS = 24;
const MAX_HOURS = 168; // one week

export async function POST(req: Request) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }
  if (!auth.isAdmin) {
    return Response.json({ error: "Admin access required" }, { status: 403 });
  }

  const url = new URL(req.url);
  const rawHours = Number.parseInt(url.searchParams.get("hours") ?? "", 10);
  const hours = Number.isFinite(rawHours)
    ? Math.min(MAX_HOURS, Math.max(1, rawHours))
    : DEFAULT_HOURS;

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return Response.json(
      { error: "Supabase service role not configured" },
      { status: 500 },
    );
  }
  const service = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const sinceISO = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  try {
    const result = await ingestTelnyxSms(service, { sinceISO });
    return Response.json({ ok: true, hours, ...result }, { status: 200 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[sms-log:ingest] failed", msg);
    return Response.json({ error: msg }, { status: 502 });
  }
}

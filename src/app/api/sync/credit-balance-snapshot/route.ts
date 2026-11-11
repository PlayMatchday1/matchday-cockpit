// GET /api/sync/credit-balance-snapshot — the day's credit balance totals into credit_balance_snapshots
// (lib/creditSnapshot, migration 0269), then every month that is over into credit_months (0270). CRON ONLY. Reads our database, never the MatchDay API.
//
// Scheduled 08:15 and 09:15 UTC, after the 3 AM Central player pass (night pass, lib/nightPass.ts). The first
// tick stands down if the pass is still running; the second takes it then. A day with a night snapshot is not
// taken again; a closed month is never written again. Logged to fin_sync_log as 'credit-balance-snapshot'.

import { timingSafeEqual } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { takeCreditSnapshot } from "@/lib/creditSnapshot";
import { closeCreditMonths } from "@/lib/creditsReportLoad";
import { syncLogWritable } from "@/lib/syncLogging";

export const maxDuration = 120;
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function constantTimeMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export async function GET(req: Request) {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/, "").trim();
  const cronSecret = process.env.CRON_SECRET;
  if (!(token && cronSecret && constantTimeMatch(token, cronSecret))) return Response.json({ error: "Not allowed." }, { status: 401 });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim(), key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return Response.json({ error: "Supabase env not configured" }, { status: 500 });
  const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const startedAt = new Date().toISOString();
  const r = await takeCreditSnapshot(sb, "cron").catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }));
  /* Then close any month that is over (migration 0270). Its own result, so a failed close never hides the
   * snapshot's, and it runs whatever the snapshot did: it reads bookings, not balances. */
  const months = await closeCreditMonths(sb).then((x) => ({ ok: true as const, ...x })).catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }));
  if (syncLogWritable() && !("skipped" in r && r.skipped.startsWith("Today's"))) {
    await sb.from("fin_sync_log").insert({
      source: "credit-balance-snapshot", triggered_by: "cron", started_at: startedAt, completed_at: new Date().toISOString(),
      rows_imported: "day" in r ? 1 : 0, api_calls: 0, run_mode: "full",
      error_message: [r.ok ? ("skipped" in r ? r.skipped : null) : r.error, months.ok ? null : `closing months: ${months.error}`].filter(Boolean).join(" · ").slice(0, 500) || null,
    });
  }
  return Response.json({ ...r, months }, { status: r.ok && months.ok ? 200 : 500 });
}
export const POST = GET;

// GET /api/sync/app-request-log-retention — daily. CRON ONLY. Windows (0257, 0258): app_request_log and
// app_request_bg_hourly 90 days; raw app_request_log_batches 7 days; the hourly route and batch rollups 365 days.
// Database only: no MatchDay API request, so it needs no pacing and no night-pass slot.
// Each DELETE carries a WHERE on the timestamp (pg_safeupdate rejects an unqualified one).

import { timingSafeEqual } from "node:crypto";
import { makeServerClient } from "@/lib/supabaseServer";

export const maxDuration = 300;
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
  const sb = makeServerClient();
  const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
  const done: Record<string, number | null> = {};
  // Each table and its window (0258). Every DELETE carries a WHERE on its timestamp column.
  const plan: [string, string, number][] = [
    ["app_request_log", "ts", 90],
    ["app_request_bg_hourly", "hour", 90],
    ["app_request_log_batches", "received_at", 7],
    ["app_request_route_hourly", "hour", 365],
    ["app_request_batch_hourly", "hour", 365],
  ];
  for (const [table, col, days] of plan) {
    const r = await sb.from(table).delete({ count: "exact" }).lt(col, ago(days));
    if (r.error) return Response.json({ ok: false, step: table, deleted: done, error: r.error.message }, { status: 500 });
    done[table] = r.count;
  }
  return Response.json({ ok: true, deleted: done });
}

// Vercel cron calls GET; POST stays an entry point (cron-verb-test).
export const POST = GET;

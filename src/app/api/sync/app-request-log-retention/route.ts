// GET /api/sync/app-request-log-retention — daily. Deletes app_request_log rows whose ts is older
// than 90 days, and app_request_log_batches rows received more than 90 days ago (0257). CRON ONLY.
// Database only: no MatchDay API request, so it needs no pacing and no night-pass slot.
// Each DELETE carries a WHERE on the timestamp (pg_safeupdate rejects an unqualified one).

import { timingSafeEqual } from "node:crypto";
import { makeServerClient } from "@/lib/supabaseServer";

export const maxDuration = 300;
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RETENTION_DAYS = 90;

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
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString();
  const lines = await sb.from("app_request_log").delete({ count: "exact" }).lt("ts", cutoff);
  if (lines.error) return Response.json({ ok: false, step: "app_request_log", error: lines.error.message }, { status: 500 });
  const batches = await sb.from("app_request_log_batches").delete({ count: "exact" }).lt("received_at", cutoff);
  if (batches.error) return Response.json({ ok: false, step: "app_request_log_batches", deletedLines: lines.count, error: batches.error.message }, { status: 500 });
  return Response.json({ ok: true, cutoff, deletedLines: lines.count, deletedBatches: batches.count });
}

// Vercel cron calls GET; POST stays an entry point (cron-verb-test).
export const POST = GET;

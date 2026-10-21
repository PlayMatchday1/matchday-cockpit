// GET /api/sync/player-areas/unlisted — night pass, after the full player walk: re-read through the
// detail endpoint the mdapi_users rows that walk did not return (refreshUnlisted, playerAreaSync.ts).
// At most UNLISTED_MAX requests, paced. CRON ONLY. Stands down if the walk is still running. Logged as
// 'mdapi-users-full' with run_mode 'unlisted'.

import { timingSafeEqual } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { isLive, refreshUnlisted, type RunRow } from "@/lib/playerAreaSync";

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
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim(), key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return Response.json({ error: "Supabase env not configured" }, { status: 500 });
  const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const startedAt = new Date().toISOString();
  const open = await sb.from("player_area_sync_runs").select("finished_at,heartbeat_at,started_at").is("finished_at", null).eq("kind", "full");
  if (open.error) return Response.json({ ok: false, error: open.error.message }, { status: 500 });
  const busy = ((open.data ?? []) as Pick<RunRow, "finished_at" | "heartbeat_at" | "started_at">[]).some((r) => isLive(r, Date.now()));
  const r = busy
    ? { ok: false, checked: 0, refreshed: 0, scrubbed: 0, gone: 0, apiCalls: 0, error: "Stood down: the night's full player pass is still running." }
    : await refreshUnlisted(sb).catch((e: unknown) => ({ ok: false, checked: 0, refreshed: 0, scrubbed: 0, gone: 0, apiCalls: 0, error: e instanceof Error ? e.message : String(e) }));
  if (!("skipped" in r && r.skipped)) {
    await sb.from("fin_sync_log").insert({
      source: "mdapi-users-full", triggered_by: "cron", started_at: startedAt, completed_at: new Date().toISOString(),
      rows_imported: r.refreshed, api_calls: r.apiCalls, run_mode: "unlisted",
      error_message: r.ok ? null : (r.error ?? "failed").slice(0, 500),
    });
  }
  return Response.json(r, { status: r.ok ? 200 : 500 });
}
export const POST = GET;

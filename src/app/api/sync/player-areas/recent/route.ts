// GET|POST /api/sync/player-areas/recent — the HOURLY INCREMENTAL location sync, and Sync now.
//
// GET /admin/players?locationUpdatedSince=<start of the last successful run − 1 h>&limit=200
// (runIncremental, playerAreaSync.ts). Usually one MatchDay request. Paced, no retries, stopped by the
// first error; the retry is the next hour's run.
//
// SCHEDULED at :35 past every hour (vercel.json, `35 * * * *`), clear of the matches job (:00) and the
// signup sync (:05); it stands down in the night pass's hour (lib/nightPass.ts). It runs in the
// evening too: one request an hour is not what the evening block protects against.
//
// Auth: CRON_SECRET for the schedule (GET or POST). A MANUAL run — Sync now — is POST only, from the
// Data page: behind the Tech gate AND admin only, refused while a run is in progress and for 10
// minutes after the last run started (playerAreaSyncStatus.ts).

import { timingSafeEqual } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { authenticateCapability } from "@/lib/capabilityAuth";
import { runIncremental } from "@/lib/playerAreaSync";
import { readSyncStatus, SYNC_PAUSED } from "@/lib/playerAreaSyncStatus";
import { inNightPassHour, NIGHT_PASS_SKIP } from "@/lib/nightPass";

export const maxDuration = 300;
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function constantTimeMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export async function POST(req: Request) {
  if (SYNC_PAUSED) return Response.json({ error: SYNC_PAUSED, paused: true }, { status: 503 });
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/, "").trim();
  const cronSecret = process.env.CRON_SECRET;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim(), key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return Response.json({ error: "Supabase env not configured" }, { status: 500 });
  const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  const isCron = !!(token && cronSecret && constantTimeMatch(token, cronSecret));
  if (!isCron) {
    if (req.method !== "POST") return Response.json({ error: "A manual sync is POST only." }, { status: 405 });
    const auth = await authenticateCapability(req, "tech");
    if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
    if (!auth.isAdmin) return Response.json({ error: "Only admins can start a sync." }, { status: 403 });
    const status = await readSyncStatus(sb).catch((e: unknown) => e instanceof Error ? e : new Error(String(e)));
    if (status instanceof Error) return Response.json({ error: `Could not read sync state: ${status.message}` }, { status: 500 });
    if (status.running) return Response.json({ error: "A sync is already running.", running: status.running }, { status: 409 });
    if (status.availableAt) return Response.json({ error: "Sync now is cooling down.", availableAt: status.availableAt }, { status: 429 });
  }
  const triggeredBy = isCron ? "cron" as const : "manual" as const;
  // In the 08:00 UTC hour the night's full pass has just read every player (lib/nightPass.ts).
  if (isCron && inNightPassHour()) return Response.json({ triggeredBy, ok: true, skipped: NIGHT_PASS_SKIP });
  try {
    const r = await runIncremental(sb, triggeredBy);
    return Response.json({ triggeredBy, ...r }, { status: r.ok ? 200 : 502 });
  } catch (e) {
    return Response.json({ triggeredBy, ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
export const GET = POST;

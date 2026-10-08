// GET|POST /api/sync/player-areas — the 6-hourly walk that feeds the Locations page.
//
// SCHEDULED every 6 hours at :40 UTC — 00:40, 06:40, 12:40, 18:40 (vercel.json, `40 */6 * * *`),
// set by Ryan after reviewing the API dyno's memory during the seeding run (2026-10-08). Clear of
// the 09:00 UTC mdapi_users full walk, which already takes the dyno past its quota on its own.
//
// Reads GET /admin/cities and every page of GET /admin/players (~140 calls at limit=250, half a
// second apart, no retries) and writes player_area_seen + one player_area_sync_runs row. The rules
// of the walk — and the 503 storm that set them — are in src/lib/playerAreaSync.ts.
//
// It never writes MatchDay — reads only — so there is no host guard or change_log entry to make.
//
// Auth: CRON_SECRET for the schedule (GET or POST). A MANUAL run — the Locations page's Sync now —
// is POST only, behind the Growth gate AND admin only (is_admin, read fresh by the gate), and is refused while a run is in
// progress and for 30 minutes after the last run started (playerAreaSyncStatus.ts). It answers 202
// at once and runs via after(); the page polls /api/sync/player-areas/status for progress. No retry
// anywhere: a failed run is recorded and shown, and the next one is a person's or the cron's call.

import { timingSafeEqual } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { authenticateCapability } from "@/lib/capabilityAuth";
import { after } from "next/server";
import { syncPlayerAreas } from "@/lib/playerAreaSync";
import { readSyncStatus } from "@/lib/playerAreaSyncStatus";

/* ~140 pages × (≈0.75s response + 0.5s pause) ≈ 3 minutes. 300s is the ceiling. A run killed here
 * leaves an unfinished run row; the lock treats it as dead after 6 minutes and the next run opens
 * with a limit=1 test read. */
export const maxDuration = 300;
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function constantTimeMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export async function POST(req: Request) {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/, "").trim();
  const cronSecret = process.env.CRON_SECRET;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!supabaseUrl || !serviceKey) {
    return Response.json({ error: "Supabase env not configured" }, { status: 500 });
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const isCron = !!(token && cronSecret && constantTimeMatch(token, cronSecret));
  if (!isCron) {
    if (req.method !== "POST") return Response.json({ error: "A manual sync is POST only." }, { status: 405 });
    // The Growth gate (the page moved there 2026-10-08), THEN admin: Sync now is admin only.
    const auth = await authenticateCapability(req, "growth");
    if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
    if (!auth.isAdmin) return Response.json({ error: "Only admins can start a sync." }, { status: 403 });

    const status = await readSyncStatus(supabase).catch((e: unknown) => e instanceof Error ? e : new Error(String(e)));
    if (status instanceof Error) return Response.json({ error: `Could not read sync state: ${status.message}` }, { status: 500 });
    if (status.running) {
      return Response.json({ error: "A sync is already running.", running: status.running }, { status: 409 });
    }
    if (status.availableAt) {
      return Response.json({ error: "Sync now is cooling down.", availableAt: status.availableAt }, { status: 429 });
    }
    // Claimed inside syncPlayerAreas (its lock settles a race between two clicks); the response does
    // not wait for the ~3 minute walk.
    after(async () => { await syncPlayerAreas(supabase, "manual").catch(() => undefined); });
    return Response.json({ accepted: true, triggeredBy: "manual" }, { status: 202 });
  }

  const triggeredBy = "cron" as const;
  try {
    const result = await syncPlayerAreas(supabase, triggeredBy);
    // A skipped run (another pass in progress) is ok:true with `skipped` — not an error.
    return Response.json({ triggeredBy, ...result }, { status: result.ok ? 200 : 500 });
  } catch (e) {
    // Only the run-row insert throws — e.g. migration 0215 not applied yet. Say so loudly.
    return Response.json({ triggeredBy, ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

// Vercel cron sends GET (see users-recent for the 405 story). A GET that is not the cron is refused
// inside POST's manual branch, so a link or a prefetch can never start a run.
export const GET = POST;

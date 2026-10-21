// GET|POST /api/sync/player-areas — the DAILY FULL PASS: every player, into player_area_seen and
// mdapi_users. CRON ONLY.
//
// SCHEDULED at 08:00 UTC (vercel.json, `0 8 * * *`): 3 AM Central in summer time, 2 AM in winter —
// first of the night's full reads (lib/nightPass.ts has the whole schedule). The hourly jobs stand
// down while it runs. Ryan, 2026-10-21: a full read of the production
// API happens at night or not at all, so there is no manual full pass. Sync now on the Data page runs
// an incremental run instead (/api/sync/player-areas/recent).
//
// A PASS IS A CHAIN OF LEGS (playerAreaSync.ts): the cron opens a pass (startPass: one run row) and
// answers 202 at once; after() runs the first leg; /api/sync/player-areas/continue, every 5 minutes,
// runs each next leg until the walk ends or a stop rule fires. About 2 legs, ~5 minutes.
//
// It never writes MatchDay — reads only — so there is no host guard or change_log entry to make.
// No retry anywhere: a failed pass is recorded and shown, and the next one is tomorrow's cron.

import { timingSafeEqual } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { after } from "next/server";
import { EVENING_MESSAGE, inEveningBlock, runLeg, startPass } from "@/lib/playerAreaSync";
import { SYNC_PAUSED } from "@/lib/playerAreaSyncStatus";

export const maxDuration = 300;
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function constantTimeMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/* THE FIRST LEG, inside after(). The continuation cron runs the rest. */
async function firstLeg(sb: SupabaseClient, runId: number) {
  await runLeg(sb, runId).catch(() => undefined);
}
export async function POST(req: Request) {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/, "").trim();
  const cronSecret = process.env.CRON_SECRET;
  if (!(token && cronSecret && constantTimeMatch(token, cronSecret))) {
    return Response.json({
      error: "The full location pass runs on its nightly schedule only. Sync now runs an incremental sync: POST /api/sync/player-areas/recent.",
    }, { status: 405 });
  }
  // PAUSED: refused before anything else — no MatchDay call, no run row.
  if (SYNC_PAUSED) return Response.json({ error: SYNC_PAUSED, paused: true }, { status: 503 });
  if (inEveningBlock(new Date())) return Response.json({ error: EVENING_MESSAGE, evening: true });
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!supabaseUrl || !serviceKey) {
    return Response.json({ error: "Supabase env not configured" }, { status: 500 });
  }
  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let started: Awaited<ReturnType<typeof startPass>>;
  try {
    started = await startPass(supabase, "cron");
  } catch (e) {
    return Response.json({ triggeredBy: "cron", ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
  // Another run in progress is not an error.
  if ("skipped" in started) return Response.json({ triggeredBy: "cron", ok: true, skipped: started.skipped });
  const runId = started.runId;
  after(async () => { await firstLeg(supabase, runId); });
  return Response.json({ accepted: true, triggeredBy: "cron", runId }, { status: 202 });
}

// Vercel cron sends GET. A GET that is not the cron is refused like any other caller.
export const GET = POST;

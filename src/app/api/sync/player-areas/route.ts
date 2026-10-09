// GET|POST /api/sync/player-areas — the walk that feeds the Locations page.
//
// SCHEDULED at 05:10, 11:10 and 17:10 UTC (vercel.json, `10 5,11,17 * * *`; Ryan, 2026-10-08):
// clear of the 09:00 UTC mdapi_users walk and of evening match hours. Nothing starts — cron or
// manual — between 22:00 and 04:00 UTC (playerAreaSync.ts, inEveningBlock), enforced here.
//
// A PASS IS A CHAIN OF LEGS. 50 players a page, 2 seconds apart, is about 30 minutes of reading;
// one function run is 300 s. So:
//   1. The cron (or Sync now) opens a pass (startPass: one run row) and answers 202 at once.
//   2. after() runs the first LEG: pages until its 230 s budget is spent (runLeg), then saves its place.
//   3. /api/sync/player-areas/continue, a cron every 5 minutes, runs each next leg of an open pass
//      (continueOpenPass) until the walk ends or a stop rule fires. About 8 legs, ~40 minutes.
//   4. A leg that dies leaves a stale heartbeat; the next continuation or pass closes it as "stalled".
//      Either way the next scheduled pass starts fresh.
//
// It never writes MatchDay — reads only — so there is no host guard or change_log entry to make.
//
// Auth: CRON_SECRET for the schedule (GET or POST). A MANUAL pass — Sync now — is
// POST only, from the Data page: behind the Tech gate AND admin only, refused in the evening block, while a pass is in
// progress, and for 30 minutes after the last pass started (playerAreaSyncStatus.ts). No retry
// anywhere: a failed pass is recorded and shown, and the next one is a person's or the cron's call.

import { timingSafeEqual } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { authenticateCapability } from "@/lib/capabilityAuth";
import { after } from "next/server";
import { EVENING_MESSAGE, inEveningBlock, runLeg, startPass } from "@/lib/playerAreaSync";
import { readSyncStatus, SYNC_PAUSED } from "@/lib/playerAreaSyncStatus";

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
  // PAUSED: refused before anything else, cron and manual alike — no MatchDay call, no run row.
  if (SYNC_PAUSED) return Response.json({ error: SYNC_PAUSED, paused: true }, { status: 503 });
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
    // The Data page's gate (Sync now lives there since 2026-10-08), THEN admin.
    const auth = await authenticateCapability(req, "tech");
    if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
    if (!auth.isAdmin) return Response.json({ error: "Only admins can start a sync." }, { status: 403 });
  }
  if (inEveningBlock(new Date())) {
    return Response.json({ error: EVENING_MESSAGE, evening: true }, { status: isCron ? 200 : 409 });
  }
  if (!isCron) {
    const status = await readSyncStatus(supabase).catch((e: unknown) => e instanceof Error ? e : new Error(String(e)));
    if (status instanceof Error) return Response.json({ error: `Could not read sync state: ${status.message}` }, { status: 500 });
    if (status.running) return Response.json({ error: "A sync is already running.", running: status.running }, { status: 409 });
    if (status.availableAt) return Response.json({ error: "Sync now is cooling down.", availableAt: status.availableAt }, { status: 429 });
  }

  const triggeredBy = isCron ? "cron" as const : "manual" as const;
  let started: Awaited<ReturnType<typeof startPass>>;
  try {
    started = await startPass(supabase, triggeredBy);
  } catch (e) {
    return Response.json({ triggeredBy, ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
  // Another pass in progress is not an error.
  if ("skipped" in started) return Response.json({ triggeredBy, ok: true, skipped: started.skipped }, { status: isCron ? 200 : 409 });
  const runId = started.runId;
  after(async () => { await firstLeg(supabase, runId); });
  return Response.json({ accepted: true, triggeredBy, runId }, { status: 202 });
}

// Vercel cron sends GET. A GET that is not the cron is refused inside POST's manual branch, so a
// link or a prefetch can never start a pass.
export const GET = POST;

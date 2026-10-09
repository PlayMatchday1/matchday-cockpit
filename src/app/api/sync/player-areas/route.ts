// GET|POST /api/sync/player-areas — the walk that feeds the Locations page.
//
// SCHEDULED at 05:10, 11:10 and 17:10 UTC (vercel.json, `10 5,11,17 * * *`; Ryan, 2026-10-08):
// clear of the 09:00 UTC mdapi_users walk and of evening match hours. Nothing starts — cron or
// manual — between 22:00 and 04:00 UTC (playerAreaSync.ts, inEveningBlock), enforced here.
//
// A PASS IS A CHAIN OF LEGS. 50 players a page, 2 seconds apart, is about 30 minutes for a full
// pass; one function run is 300 s. So:
//   1. The cron (or Sync now) opens a pass (startPass: one run row) and answers 202 at once.
//   2. after() runs the first LEG: pages until its 230 s budget is spent (runLeg).
//   3. If the walk is not finished, the leg HANDS ON: one POST to this route, ?leg=<runId>, with the
//      CRON_SECRET bearer. That request answers 202 at once and runs the next leg in its own after(),
//      so no function waits on another. And so on until the walk ends or a stop rule fires.
//   4. A hand-on that fails ends the pass ("error"); a leg that dies leaves a stale heartbeat, and the
//      next pass to start closes it as "stalled". Either way the next scheduled pass starts fresh.
//
// It never writes MatchDay — reads only — so there is no host guard or change_log entry to make.
//
// Auth: CRON_SECRET for the schedule and for hand-ons (GET or POST). A MANUAL pass — Sync now — is
// POST only, behind the Growth gate AND admin only, refused in the evening block, while a pass is in
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

/* ONE LEG, then the hand-on to the next. Runs inside after(). */
async function legAndHandOn(sb: SupabaseClient, runId: number, origin: string, secret: string) {
  const leg = await runLeg(sb, runId).catch((e: unknown) => ({ ok: false, more: false, error: e instanceof Error ? e.message : String(e) }));
  if (!leg.more) return;
  const fail = async (why: string) => {
    await sb.from("player_area_sync_runs").update({
      finished_at: new Date().toISOString(), ok: false, stop_reason: "error", next_page: null,
      error: `stopped: the hand-on to the next leg failed (${why})`,
    }).eq("id", runId).is("finished_at", null);
    await sb.from("player_area_pass_seen").delete().eq("run_id", runId);
  };
  try {
    const res = await fetch(`${origin}/api/sync/player-areas?leg=${runId}`, {
      method: "POST", headers: { Authorization: `Bearer ${secret}` }, cache: "no-store",
    });
    if (res.status !== 202) await fail(`HTTP ${res.status}`);
  } catch (e) {
    await fail(e instanceof Error ? e.message : String(e));
  }
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
  const url = new URL(req.url);
  const origin = url.origin;

  const isCron = !!(token && cronSecret && constantTimeMatch(token, cronSecret));

  // ── A HAND-ON: the next leg of a pass already running. Cron secret only. ──
  const legParam = url.searchParams.get("leg");
  if (legParam != null) {
    if (!isCron) return Response.json({ error: "Not allowed." }, { status: 401 });
    const runId = Number(legParam);
    if (!Number.isInteger(runId) || runId <= 0) return Response.json({ error: "Bad leg id." }, { status: 400 });
    after(async () => { await legAndHandOn(supabase, runId, origin, cronSecret!); });
    return Response.json({ accepted: true, leg: runId }, { status: 202 });
  }

  if (!isCron) {
    if (req.method !== "POST") return Response.json({ error: "A manual sync is POST only." }, { status: 405 });
    const auth = await authenticateCapability(req, "growth");
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
  if (!cronSecret) return Response.json({ error: "CRON_SECRET is not configured, so a pass could not hand on between legs." }, { status: 500 });

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
  after(async () => { await legAndHandOn(supabase, runId, origin, cronSecret); });
  return Response.json({ accepted: true, triggeredBy, runId }, { status: 202 });
}

// Vercel cron sends GET. A GET that is not the cron is refused inside POST's manual branch, so a
// link or a prefetch can never start a pass.
export const GET = POST;

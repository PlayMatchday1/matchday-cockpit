// GET|POST /api/sync/player-areas — the DAILY FULL PASS: every player, into player_area_seen and
// mdapi_users. The nightly cron, and — since 2026-10-23 — "Run full sync" on the Data page.
//
// SCHEDULED at 08:00 UTC (vercel.json, `0 8 * * *`): 3 AM Central in summer time, 2 AM in winter —
// first of the night's full reads (lib/nightPass.ts has the whole schedule). The hourly jobs stand
// down while it runs. The schedule is unchanged.
//
// MANUAL FULL PASS (Ryan, 2026-10-23, replacing his 2026-10-21 "at night or not at all"): Warsaw
// joined the city list in a change that only a full pass picks up (only a full pass reads
// /admin/cities), and Sync now runs the incremental pass, so there was no way to apply it before the
// next night. A manual full pass is POST only, behind the Tech gate AND admin only, and refused while
// any run is live (409 — the same lock startPass enforces, so it cannot overlap the :35 hourly run in
// either direction), for 10 minutes after the last run of either kind started (429, the Sync now
// guard), and in the evening block (409). It is the same pass the cron opens — same legs, same pacing,
// same stop rules — logged with triggered_by "manual".
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
import { authenticateCapability } from "@/lib/capabilityAuth";
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
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/, "").trim();
  const cronSecret = process.env.CRON_SECRET;
  const isCron = !!(token && cronSecret && constantTimeMatch(token, cronSecret));
  // PAUSED: refused before anything else — no MatchDay call, no run row.
  if (SYNC_PAUSED) return Response.json({ error: SYNC_PAUSED, paused: true }, { status: 503 });
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!supabaseUrl || !serviceKey) {
    return Response.json({ error: "Supabase env not configured" }, { status: 500 });
  }
  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  if (!isCron) {
    // RUN FULL SYNC (the Data page). Same gate and guards as Sync now, plus the evening block.
    if (req.method !== "POST") return Response.json({ error: "A manual full pass is POST only." }, { status: 405 });
    const auth = await authenticateCapability(req, "tech");
    if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
    if (!auth.isAdmin) return Response.json({ error: "Only admins can start a sync." }, { status: 403 });
    const status = await readSyncStatus(supabase).catch((e: unknown) => e instanceof Error ? e : new Error(String(e)));
    if (status instanceof Error) return Response.json({ error: `Could not read sync state: ${status.message}` }, { status: 500 });
    if (status.running) return Response.json({ error: "A sync is already running.", running: status.running }, { status: 409 });
    if (status.availableAt) return Response.json({ error: "Syncs are cooling down.", availableAt: status.availableAt }, { status: 429 });
    if (inEveningBlock(new Date())) return Response.json({ error: EVENING_MESSAGE, evening: true }, { status: 409 });
  } else if (inEveningBlock(new Date())) {
    return Response.json({ error: EVENING_MESSAGE, evening: true });
  }
  const triggeredBy = isCron ? "cron" as const : "manual" as const;

  let started: Awaited<ReturnType<typeof startPass>>;
  try {
    started = await startPass(supabase, triggeredBy);
  } catch (e) {
    return Response.json({ triggeredBy, ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
  // Another run in progress is not an error for the cron; a person is told it did not start.
  if ("skipped" in started) return Response.json({ triggeredBy, ok: true, skipped: started.skipped }, { status: isCron ? 200 : 409 });
  const runId = started.runId;
  after(async () => { await firstLeg(supabase, runId); });
  return Response.json({ accepted: true, triggeredBy, runId }, { status: 202 });
}

// Vercel cron sends GET. A GET that is not the cron is refused like any other caller.
export const GET = POST;

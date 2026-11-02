// POST|GET /api/sync/watchdog: hourly at :45 (vercel.json). Marks scheduled sync steps the platform cut
// off, finds any watched sync with no clean completion in 2 days, and pushes Ryan once a day when
// there is one (lib/syncWatchdog.ts). CRON_SECRET only; nothing a person can call.

import { cronClient } from "@/lib/syncJob";
import { runSyncWatchdog } from "@/lib/syncWatchdog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  const c = cronClient(req);
  if (c instanceof Response) return c;
  try {
    const out = await runSyncWatchdog(c.supabase);
    console.log(`[sync-watchdog] ${JSON.stringify(out).slice(0, 800)}`);
    return Response.json(out);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}

// Vercel cron issues a GET; POST is the entry point, GET its alias (scripts/cron-verb-test.ts).
export const GET = POST;

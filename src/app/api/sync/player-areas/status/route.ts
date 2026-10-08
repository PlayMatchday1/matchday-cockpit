// GET /api/sync/player-areas/status — what the Locations page's Sync now button shows: a run in
// progress (pages done / total), the last finished run, and when a manual run is allowed again.
// Supabase only. Match Ops read: anyone on the page may see the state; only admins may trigger.

import { authenticateMatchOpsRead } from "@/lib/matchOpsAuth";
import { readSyncStatus } from "@/lib/playerAreaSyncStatus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await authenticateMatchOpsRead(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  try {
    return Response.json({ ...(await readSyncStatus(auth.supabase)), canSync: auth.isAdmin },
      { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}

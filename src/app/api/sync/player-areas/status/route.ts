// GET /api/sync/player-areas/status — what the Data page's player-locations card and its Recent syncs
// list show: a pass in progress (pages done / total), the recent passes, and when a manual pass is
// allowed again. Supabase only. The Tech gate, like the Data page itself (Sync now moved there from
// Locations, 2026-10-08): anyone who can open the page may see the state; only admins may start one.

import { authenticateCapability } from "@/lib/capabilityAuth";
import { readSyncStatus } from "@/lib/playerAreaSyncStatus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await authenticateCapability(req, "tech");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  try {
    return Response.json({ ...(await readSyncStatus(auth.supabase)), canSync: auth.isAdmin },
      { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}

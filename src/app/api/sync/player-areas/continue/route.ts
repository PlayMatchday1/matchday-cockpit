// GET /api/sync/player-areas/continue — every 5 minutes (vercel.json): the next leg of an open
// player-areas pass, if there is one. CRON_SECRET only; nothing a person can call. With no open pass
// it reads one row from Supabase and returns — no MatchDay call. The rules of the walk, including the
// evening block and the health checks, are in src/lib/playerAreaSync.ts and apply to every leg.

import { timingSafeEqual } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { continueOpenPass } from "@/lib/playerAreaSync";
import { SYNC_PAUSED } from "@/lib/playerAreaSyncStatus";

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
  if (SYNC_PAUSED) return Response.json({ paused: SYNC_PAUSED });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim(), key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return Response.json({ error: "Supabase env not configured" }, { status: 500 });
  const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  try {
    return Response.json(await continueOpenPass(sb));
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
export const POST = GET;

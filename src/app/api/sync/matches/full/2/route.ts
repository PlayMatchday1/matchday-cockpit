// GET /api/sync/matches/full/2 — matches and every roster, quarter 2 of 4 of the window — the night pass (lib/nightPass.ts). Handler: lib/nightPassRoutes.ts. CRON ONLY.
import { matchesFullSlice } from "@/lib/nightPassRoutes";
export const maxDuration = 300;
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(req: Request) {
  return matchesFullSlice(req, 2);
}
// Vercel cron sends GET (scripts/cron-verb-test.ts).
export const GET = POST;

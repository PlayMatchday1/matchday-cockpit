// GET /api/sync/reviews/full/1 — the full reviews walk, half 1 of 2 — the night pass (lib/nightPass.ts). Handler: lib/nightPassRoutes.ts. CRON ONLY.
import { reviewsFullHalf } from "@/lib/nightPassRoutes";
export const maxDuration = 300;
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(req: Request) {
  return reviewsFullHalf(req, 1);
}
// Vercel cron sends GET (scripts/cron-verb-test.ts).
export const GET = POST;

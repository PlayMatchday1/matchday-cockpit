// GET /api/covers/status — whether cover photos are available here, and whether this person may edit them.
// The two cover components ask this first and render nothing when unavailable (no control that does nothing).
// The gate lives in fieldCoversServer (coversStatus), like every other /api/covers route.
import { coversStatus } from "@/lib/fieldCoversServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return coversStatus(req);
}

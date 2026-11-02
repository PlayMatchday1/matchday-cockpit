/* GET /api/lifecycle/acquisition?since=&until=[&compare=1]
 *
 * The Acquisition page's own payload: the Website table (current and comparison), Apple's first-time
 * downloads by source and per Website row (0210, lib/acquisitionModel.downloadsTable), how current
 * each source is — and EACH SOURCE'S WINDOW, trimmed
 * to that source's own "data through" day, with its comparison the trimmed window a month earlier
 * (lib/acquisitionModel.sourceWindows). The Ads table comes from /api/lifecycle/ads, given the meta
 * window from here. A server route because every acq_* table is service-role only (0203). Gated on
 * can_access_lifecycle. Read-only.
 */

import { authenticateLifecycle } from "@/lib/lifecycleAuth";
import { acquisitionResponse } from "@/lib/acquisitionCompute";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: Request) {
  const auth = await authenticateLifecycle(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  return acquisitionResponse(auth, new URL(req.url));
}

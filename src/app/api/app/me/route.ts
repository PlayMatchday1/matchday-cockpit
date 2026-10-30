// Staff app: WHO AM I. The app calls this straight after sign-in and on every launch. A refusal here
// is the server-side "not staff" answer: no app_users row, or a service account, is a 403 with a
// sentence the phone shows as-is. What it returns is for display; every other /api/app/* route
// re-reads the row and decides again.

import { authenticateApp } from "@/lib/appAuth";
import { cityNameFor } from "@/lib/cityScope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await authenticateApp(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const row = auth.row;
  return Response.json({
    appUserId: auth.appUserId,
    email: auth.email,
    fullName: typeof row.full_name === "string" ? row.full_name : null,
    tier: auth.tier,
    canReadMatches: auth.canReadMatches,
    confined: auth.confined,
    city: auth.scopeCity,
    cityName: auth.scopeCity ? cityNameFor(auth.scopeCity) : null,
  });
}

// Staff app: WHO AM I. The app calls this straight after sign-in and on every launch. A refusal here
// is the server-side "not staff" answer: no app_users row, or a service account, is a 403 with a
// sentence the phone shows as-is. What it returns is for display; every other /api/app/* route
// re-reads the row and decides again.

import { authenticateApp } from "@/lib/appAuth";
import { cityNameFor } from "@/lib/cityScope";
import { can } from "@/lib/capabilities";

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
    // A COURTESY for greying Save, from the same predicate the desktop UI uses. The adjust route
    // does not read this: the desktop write handlers it calls re-check the grant on every request.
    canEditMatches: can(row, "editMatches", auth.email),
    // The same courtesy for the chat composers. The send routes (/api/crm/send, the match chat
    // reply) re-check can_send_messages themselves before anything is sent.
    canSendMessages: can(row, "sendMessages", auth.email),
    // Player Lookup's membership and strike controls; every write route re-checks.
    canEditMemberships: can(row, "editMemberships", auth.email),
    canManagePlayers: can(row, "managePlayers", auth.email),
    // Manager Schedule pay changes: the app refuses them to a city-confined account.
    canChangeManagerPay: !auth.confined,
  });
}

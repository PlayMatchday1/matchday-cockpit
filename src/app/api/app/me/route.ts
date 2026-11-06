// Staff app: WHO AM I. The app calls this straight after sign-in and on every launch. A refusal here
// is the server-side "not staff" answer: no app_users row, or a service account, is a 403 with a
// sentence the phone shows as-is. What it returns is for display; every other /api/app/* route
// re-reads the row and decides again.
//
// ?signedIn=1, sent once straight after a sign-in, records last_login_at here with the service role
// (Ryan, 2026-11-02): the app used to write it from the phone, which RLS refused without a word.

import { authenticateApp } from "@/lib/appAuth";
import { cityNameFor } from "@/lib/cityScope";
import { can } from "@/lib/capabilities";
import { canViewAs } from "@/lib/viewAs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await authenticateApp(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const row = auth.row;
  // Never while viewing as: that would stamp the viewed user's last login.
  if (!auth.viewAs && new URL(req.url).searchParams.get("signedIn") === "1") {
    const u = await auth.supabase.from("app_users").update({ last_login_at: new Date().toISOString() }).eq("id", auth.appUserId);
    if (u.error) console.warn(`[app-me] last_login_at for ${auth.appUserId}: ${u.error.message}`);
  }
  // VIEW AS: the row above is the viewed user's. Who is really signed in decides the Me row
  // (shown to admins only); the real row is read only when no View as is on.
  let realCanViewAs = false;
  if (!auth.viewAs) realCanViewAs = canViewAs(row);
  return Response.json({
    appUserId: auth.appUserId,
    // Courtesy for the Me screen's "View as" row; /api/app/view-as re-checks is_admin itself.
    canViewAs: realCanViewAs,
    viewingAs: auth.viewAs ? { adminName: auth.viewAs.adminName, adminEmail: auth.viewAs.adminEmail, startedAt: new Date(auth.viewAs.startedAt).toISOString(), expiresAt: new Date(auth.viewAs.expiresAt).toISOString() } : null,
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
    // EDIT CREDITS: granted on its own, never by Match Ops or admin; the credits route re-checks it.
    canEditCredits: can(row, "editCredits", auth.email) && row.is_service_account !== true,
    canManagePlayers: can(row, "managePlayers", auth.email),
    // Manager Schedule pay changes: the app refuses them to a city-confined account.
    canChangeManagerPay: !auth.confined,
    // The Growth tab (2026 Daily Matches); /api/app/growth is refused without it.
    canReadGrowth: can(row, "growth", auth.email),
  });
}

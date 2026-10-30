// THE STAFF APP'S GATE, for /api/app/* only. Built on resolveSessionUser, the same bearer check and
// fresh app_users read every Clubhouse route uses, so nothing about who a person is lives in the
// phone. The decision itself is appAccess in appModel.ts.
//
// A SEPARATE GATE ON PURPOSE. The desktop Match Ops read gate refuses city managers, and the desktop
// city-manager gate refuses rosters; the app is allowed to differ from both (Ryan, 2026-10-29), and
// widening either desktop gate would change desktop pages. This one is reached only by /api/app/*.

import { type SupabaseClient } from "@supabase/supabase-js";
import { resolveSessionUser, type AppUserRow } from "./adminAuth";
import { confinedCity } from "./cityConfinement";
import { cityNameFor } from "./cityScope";
import { appAccess, type AppAccess } from "./appModel";

export const SERVICE_EMAIL = "clubhouse-e2e@playmatchday.com";

export type AppAuthResult =
  | ({ ok: true; supabase: SupabaseClient; row: AppUserRow; email: string; appUserId: string; scopeCityName: string | null } & AppAccess)
  | { ok: false; status: number; error: string };

/** Plain sentences for a phone screen, in place of the desktop's terser refusals. */
function plain(status: number, error: string): string {
  if (status === 401) return "Your session has ended. Sign in again.";
  if (error === "Not a cockpit user") return "This email is not a MatchDay staff account.";
  return error;
}

export async function authenticateApp(req: Request): Promise<AppAuthResult> {
  const r = await resolveSessionUser(req);
  if (!r.ok) return { ok: false, status: r.status, error: plain(r.status, r.error) };
  if (r.email === SERVICE_EMAIL || r.row.is_service_account === true) {
    return { ok: false, status: 403, error: "Service accounts cannot use the staff app." };
  }
  const access = appAccess(r.row, confinedCity(r.row));
  return {
    ok: true, supabase: r.supabase, row: r.row, email: r.email, appUserId: String(r.row.id),
    scopeCityName: access.scopeCity ? cityNameFor(access.scopeCity) : null,
    ...access,
  };
}

/** The refusal for a read the account cannot make at all. */
export function readRefusal(a: AppAccess): { status: number; error: string } | null {
  if (!a.canReadMatches) return { status: 403, error: "Your account does not include Match Ops. Ask an admin to grant it." };
  if (a.confined && !a.scopeCity) return { status: 403, error: "Your account's city is not one the Clubhouse recognises. Ask an admin to fix it." };
  return null;
}

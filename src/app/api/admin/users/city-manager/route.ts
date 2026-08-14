// Phase 29 Part A — granting the CITY MANAGER tier from the UI.
//
// Until now this was SQL only, and for a reason worth stating: city_identifier is free text with
// no check constraint (migration 0120 left it that way on purpose, so opening a city is not a
// migration). Every scoped query pushes `.eq("city_identifier", …)`, so a typed `dfw`, `DFW ` or
// `Dallas` does not error — it scopes the account to NOTHING and looks identical in the grid. A
// checkbox and a text box would have made that mistake one keystroke away from a real person's
// account, so the allowlist (src/lib/cityScope.ts) is enforced HERE, on the server, and the UI
// offers a dropdown that cannot express a bad value in the first place.
//
// THE RULES, all enforced here rather than only in the button:
//   1. Admin-gated, service-role.
//   2. The city must be one of the known scopes. EXACT match — no trimming, no case-fixing.
//   3. CITY MANAGER and ADMIN are mutually exclusive. cityManagerAuth REFUSES admins (an admin has
//      no city, so there is no scope to hand back), so a row holding both is a person who can use
//      neither tier properly: the admin pages bounce them out of the city page, and the city gate
//      bounces them out of the city page too.
//   4. Turning the tier off nulls the city — the 0120 trigger already does this, so the route
//      sends null too and then RE-READS, letting the database be the source of truth either way.
//   5. The E2E service account can never hold it (0120's trigger raises; this is the second lock).
//   6. Every change goes through recordWrite into change_log.

import { randomUUID } from "node:crypto";
import { authenticateAdmin } from "@/lib/adminAuth";
import { recordWrite, supabaseLogStore } from "@/lib/changeLog";
import { resolveCityScope, CITY_IDENTIFIERS } from "@/lib/cityScope";
import type { Change } from "@/lib/changeLogModel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Target = {
  id: string; email: string; is_admin: boolean; is_service_account: boolean;
  is_city_manager: boolean; city_identifier: string | null;
};
const SELECT = "id, email, is_admin, is_service_account, is_city_manager, city_identifier";

export async function POST(req: Request) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const body = (await req.json().catch(() => null)) as
    { userId?: string; isCityManager?: boolean; cityIdentifier?: string | null } | null;
  if (!body?.userId) return Response.json({ error: "userId required" }, { status: 400 });

  const cur = await auth.supabase.from("app_users").select(SELECT).eq("id", body.userId).maybeSingle();
  if (cur.error || !cur.data) return Response.json({ error: "user not found" }, { status: 404 });
  const t = cur.data as Target;

  const nextIsCm = body.isCityManager ?? t.is_city_manager;

  // RULE 4 — the tier off means no scope. Sent explicitly as well as trusted to the trigger, so
  // the intent is in the request body and in change_log, not only in a database side effect.
  let nextCity: string | null;
  if (!nextIsCm) {
    nextCity = null;
  } else {
    const raw = body.cityIdentifier !== undefined ? body.cityIdentifier : t.city_identifier;
    // RULE 2 — the allowlist. A city manager without a valid scope is not a partially-configured
    // account; it is an account whose every page is silently empty.
    const scope = resolveCityScope(raw);
    if (!scope) {
      return Response.json({
        error: raw == null || raw === ""
          ? "A city is required to make someone a City Manager — the tier scopes every page they see."
          : `${JSON.stringify(String(raw))} is not a known city. Pick one of: ${CITY_IDENTIFIERS.join(", ")}. ` +
            `An unknown value is not rejected by the database — it would scope this account to nothing and look correct in the grid.`,
      }, { status: 400 });
    }
    nextCity = scope.identifier;   // store the CANONICAL value, never the input string
  }

  // RULE 3 — mutually exclusive with ADMIN, refused at the ROUTE.
  if (nextIsCm && t.is_admin) {
    return Response.json({
      error: "This account is an Admin. City Manager and Admin are mutually exclusive: the city gate refuses admins (an admin has no city, so there is no scope), so holding both leaves the account unable to use either tier properly. Remove Admin first.",
    }, { status: 409 });
  }
  // RULE 5 — service accounts never hold it. The 0120 trigger raises P0001 too; this returns a
  // readable message instead of a database error string.
  if (nextIsCm && t.is_service_account) {
    return Response.json({ error: "Service accounts cannot be City Managers." }, { status: 403 });
  }

  const changes: Change[] = [
    { key: "is_city_manager", field: "City Manager", before: t.is_city_manager, after: nextIsCm },
    { key: "city_identifier", field: "City", before: t.city_identifier ?? "—", after: nextCity ?? "—" },
  ];

  let updErr: { message: string; code?: string } | null = null;
  const { outcome, logged } = await recordWrite(
    {
      env: "production", source: "Admin · User access · City Manager",
      actorName: auth.email, actorEmail: auth.email, saveId: randomUUID(),
      matchId: null, matchName: null,
      // The TARGET is identified by id only — never the person's email or name. change_log has
      // different access rules and a longer life than this grid.
      method: "PUT", path: `/app_users/${body.userId}`,
      body: { is_city_manager: nextIsCm, city_identifier: nextCity },
      keys: ["is_city_manager", "city_identifier"], label: (k) => k,
      applied: (_b, a) => {
        const row = (a.user as Target | undefined);
        return !!row && row.is_city_manager === nextIsCm && (row.city_identifier ?? null) === nextCity;
      },
      changes,
    },
    {
      readResource: async () => {
        const r = await auth.supabase.from("app_users").select(SELECT).eq("id", body.userId!).maybeSingle();
        return { user: r.data ?? {} };
      },
      write: async () => {
        const upd = await auth.supabase
          .from("app_users")
          .update({ is_city_manager: nextIsCm, city_identifier: nextCity })
          .eq("id", body.userId!)
          .select(SELECT)
          .maybeSingle();
        // 0120's trigger raises P0001 for a service account; surface it verbatim rather than
        // swallowing it into a generic failure.
        if (upd.error) { updErr = { message: upd.error.message, code: upd.error.code }; throw new Error(upd.error.message); }
        return upd.data;
      },
      now: () => new Date().toISOString(),
    },
    supabaseLogStore(),
  );

  if (updErr) return Response.json({ error: (updErr as { message: string }).message, code: (updErr as { code?: string }).code }, { status: 400 });

  // Re-read AFTER the write so the client renders actual DB state — the 0120 trigger nulls the
  // city on its own when the tier goes off, and the grid must show what the database did.
  const fresh = await auth.supabase.from("app_users").select(SELECT).eq("id", body.userId).maybeSingle();
  return Response.json({ ok: true, outcome, logRecorded: logged, user: fresh.data });
}

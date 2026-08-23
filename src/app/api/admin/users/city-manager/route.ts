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

import { mapAppUsersConstraint } from "@/lib/appUsersConstraint";
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
// The broad flags are selected so RULE 4 can refuse the combination that leaked. NOTE the
// adminAuth rule about never NAMING permission columns applies to THAT file (code deploys
// before migrations); these columns are long-established, and this route already 500s
// meaningfully if they are missing.
// can_access_growth IS NAMED HERE ON PURPOSE while it is dormant (0139). Ten rows still carry it
// from before the lifecycle rename, the DB CHECK still counts it as a broad flag, and no screen
// can clear it — so an account holding it would be refused by the DATABASE with nothing on the
// grid to explain why. Reading it here makes the refusal below say so by name instead.
const SELECT = "id, email, is_admin, is_service_account, is_city_manager, city_identifier, can_access_matchops, can_access_home, can_access_finance, can_access_lifecycle, can_access_growth, can_access_membership, can_access_chats, can_access_tech, can_access_org";

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

  /* RULE 4, REWRITTEN — THE CITY IS NO LONGER OWNED BY THE TIER.
   *
   * It used to read "tier off means no scope", and clearing the City Manager box wiped the city.
   * That is now wrong in both directions: a city_identifier means CONFINED TO THAT CITY, and the
   * account this exists for — the person who runs Warsaw — has a city and no City Manager box.
   * Wiping their scope when the box is off would unconfine them, which is the opposite of safe.
   *
   * SO THE TWO ARE INDEPENDENT: is_city_manager decides membership of the city-manager ledger and
   * the pay pages; city_identifier decides what an account may see. A city manager still needs a
   * city (checked below), because a city manager without one is an account whose every page is
   * silently empty — but the reverse implication is gone.
   */
  const rawCity = body.cityIdentifier !== undefined ? body.cityIdentifier : t.city_identifier;
  let nextCity: string | null;
  if (rawCity == null || rawCity === "") {
    // Explicitly cleared, or never set. A city manager cannot be left without one.
    if (nextIsCm) {
      return Response.json({
        error: "A city is required to make someone a City Manager — the tier scopes every page they see.",
      }, { status: 400 });
    }
    nextCity = null;
  } else {
    // RULE 2 — the allowlist, applied to EVERY city now, not only a city manager's. An unknown
    // value is not rejected by the database; it would confine the account to nothing and look
    // correct in the grid.
    const scope = resolveCityScope(rawCity);
    if (!scope) {
      return Response.json({
        error: `${JSON.stringify(String(rawCity))} is not a known city. Pick one of: ${CITY_IDENTIFIERS.join(", ")}. ` +
          `An unknown value is not rejected by the database — it would confine this account to nothing and look correct in the grid.`,
      }, { status: 400 });
    }
    nextCity = scope.identifier;   // store the CANONICAL value, never the input string
  }

  /* A CITY CONFINES, SO IT IS REFUSED ON AN ADMIN. The predicate holds confinement above is_admin
   * deliberately (see cityConfinement.ts), which means giving an admin a city would lock them out
   * of their own tool — Finance, Tech, Back Office, and the grant screen itself. That rule exists
   * to be SAFE if it ever happens, not to be a thing anyone can do from a dropdown. */
  if (nextCity && t.is_admin) {
    return Response.json({
      error: "An admin cannot be confined to a city — a city scopes every page the account can see, "
        + "and confinement outranks admin. Remove admin first if that is really the intent.",
    }, { status: 400 });
  }

  // RULE 3 — mutually exclusive with ADMIN, refused at the ROUTE.
  if (nextIsCm && t.is_admin) {
    return Response.json({
      error: "This account is an Admin. City Manager and Admin are mutually exclusive: the city gate refuses admins (an admin has no city, so there is no scope), so holding both leaves the account unable to use either tier properly. Remove Admin first.",
    }, { status: 409 });
  }
  // RULE 4 — THE COMBINATION THAT LEAKED (Phase 29b), refused at the ROUTE.
  // Granting the tier to an account that also holds the broad access flags is exactly how a DFW
  // city manager came to read the whole Match Ops estate, Player Lookup included: the tier was
  // ADDITIVE and the Match Ops gate knew nothing about it. The gate now confines them regardless,
  // so this is DEFENCE rather than the guarantee — but a state that cannot be created is a state
  // nobody has to notice later, and the grid is where it was created the first time.
  if (nextIsCm) {
    const broad = ["can_access_matchops", "can_access_home", "can_access_finance", "can_access_lifecycle",
      "can_access_growth", "can_access_membership", "can_access_chats", "can_access_tech",
      "can_access_org"] as const;
    const held = broad.filter((k) => (t as unknown as Record<string, unknown>)[k] === true);
    if (held.length > 0) {
      return Response.json({
        error: `This account still holds ${held.join(", ")}. A City Manager is scoped to their own city pages, so those flags grant nothing here and previously opened the whole Match Ops estate. Remove them before granting the tier.`,
        held,
      }, { status: 409 });
    }
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

  if (updErr) {
    // RULE 4 above refuses the combination before we get here, so this is belt and braces — but a
    // constraint arriving raw would still name an internal identifier at the operator.
    const mapped = mapAppUsersConstraint(updErr);
    if (mapped) return Response.json({ error: mapped.error, conflict: mapped.conflict }, { status: mapped.status });
    return Response.json({ error: (updErr as { message: string }).message, code: (updErr as { code?: string }).code }, { status: 400 });
  }

  // Re-read AFTER the write so the client renders actual DB state — the 0120 trigger nulls the
  // city on its own when the tier goes off, and the grid must show what the database did.
  const fresh = await auth.supabase.from("app_users").select(SELECT).eq("id", body.userId).maybeSingle();
  return Response.json({ ok: true, outcome, logRecorded: logged, user: fresh.data });
}

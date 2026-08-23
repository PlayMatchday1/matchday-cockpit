// Turning a DATABASE constraint violation on app_users into a stated refusal (Phase 29b).
//
// Migration 0124 makes the leaking combination unrepresentable: a city manager may not also hold
// is_admin or any broad can_access_* flag. That constraint is the third layer of defence, and it
// bites at the DATABASE — so every path that writes app_users can now fail where it previously
// succeeded, and a raw failure would surface as a Postgres string naming the constraint. That is
// a bad experience and it leaks an internal name.
//
// WHAT IS DELIBERATELY *NOT* REWRITTEN. The 0114/0116 triggers raise P0001 with messages written
// to be read by a human ("Service account (…) cannot hold EDIT MATCHES"), and match-permissions
// surfaces those verbatim on purpose. Only 23514 — check_violation — on THIS constraint is
// rewritten. Everything else passes through untouched, because swallowing an unrecognised database
// error is how a real failure becomes a shrug.
export const CITY_MANAGER_CONSTRAINT = "app_users_city_manager_is_exclusive";

// BOTH lifecycle AND growth. The DB CHECK (0139) enumerates both columns, so a violation can be
// caused by either; an array that named only one would build a message omitting the actual
// conflict. can_access_growth is dormant today and becomes the Growth tab's permission later.
const BROAD_FLAGS = [
  "is_admin", "can_access_matchops", "can_access_home", "can_access_finance",
  "can_access_lifecycle", "can_access_growth", "can_access_membership", "can_access_chats",
  "can_access_tech", "can_access_org",
] as const;

export type PgLikeError = { message?: string; code?: string; details?: string | null } | null | undefined;

/** True when `e` is the city-manager exclusivity CHECK failing. */
export function isCityManagerConstraintViolation(e: PgLikeError): boolean {
  if (!e) return false;
  const blob = `${e.message ?? ""} ${e.details ?? ""}`;
  // Match on the constraint NAME as well as the code: another CHECK on this table must not be
  // reported as this one.
  return e.code === "23514" && blob.includes(CITY_MANAGER_CONSTRAINT);
}

/**
 * The message a human should read. It says the same thing the grant route's 409 says, so the
 * database layer and the route layer do not disagree about what the rule is — and it names the
 * flags actually in conflict where the caller told us what it was writing.
 */
export function cityManagerConstraintMessage(attempted?: Record<string, unknown> | null): string {
  const held = attempted
    ? BROAD_FLAGS.filter((k) => attempted[k] === true)
    : [];
  const which = held.length ? ` The conflict is: ${held.join(", ")}.` : "";
  return (
    "A City Manager is scoped to their own city pages and cannot also hold Admin or any broad " +
    `access flag — that combination is what let a city manager read every city's data.${which} ` +
    "Remove the City Manager tier first, or leave those flags off."
  );
}

/**
 * Map a Supabase/Postgres error to a stated refusal when it is the city-manager constraint;
 * otherwise return null so the caller surfaces its own (already readable) message.
 */
export function mapAppUsersConstraint(e: PgLikeError, attempted?: Record<string, unknown> | null):
  { error: string; conflict: "city-manager-exclusive"; status: 409 } | null {
  if (!isCityManagerConstraintViolation(e)) return null;
  return { error: cityManagerConstraintMessage(attempted), conflict: "city-manager-exclusive", status: 409 };
}

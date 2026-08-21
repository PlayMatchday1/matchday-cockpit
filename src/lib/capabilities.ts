// THE CHECKBOXES ON THE USER ACCESS SCREEN ARE THE ACCESS CONTROL.
//
// If a box is ticked, the thing works. `is_admin` gates exactly one thing — the User access screen
// itself, which is who may grant permissions. Nothing else.
//
// WHY THIS FILE EXISTS. Routes used to require `is_admin` AND a flag. An admin can grant themselves
// any flag, so "admin AND the flag" only ever meant "admin" — which made every checkbox on that
// screen decoration. Measured: of 16 accounts, exactly one non-admin held can_edit_matches, and no
// non-admin has ever landed a match edit. The flag had never granted anything to anyone.
//
// PURE, AND IMPORTED BY BOTH SIDES. useAuth cannot be loaded outside a browser (it builds the
// Supabase client at module scope) and the server auth helpers cannot be loaded inside one. This
// module imports NOTHING, so the route that enforces a capability and the panel that offers it call
// THE SAME FUNCTION — not two implementations kept in step by a test.
//
// THE TWO THINGS THAT ARE NOT PAGE GATES, and survive:
//   * the E2E service account, refused every capability (belt-and-braces over the DB trigger)
//   * city managers, confined to their own city's pages
// Neither is a permission a checkbox can grant, which is exactly why neither is one.

export type CapRow = Record<string, unknown>;

// A capability is a column on app_users. The name maps to the box on the User access screen.
export type Capability =
  // Page access — the broad "can they open this section" flags.
  | "home" | "finance" | "growth" | "membership" | "matchops" | "chats" | "tech" | "org"
  // Write grants — each nested under Match Ops on the grid, each off by default.
  | "editMatches" | "managePlayers" | "managePromos" | "editCredits" | "sendMessages"
  // The ONE thing is_admin still means: who may grant permissions.
  | "grantAccess";

const COLUMN: Record<Capability, string> = {
  home: "can_access_home", finance: "can_access_finance", growth: "can_access_growth",
  membership: "can_access_membership", matchops: "can_access_matchops", chats: "can_access_chats",
  tech: "can_access_tech", org: "can_access_org",
  editMatches: "can_edit_matches", managePlayers: "can_manage_players",
  managePromos: "can_manage_promos", editCredits: "can_edit_credits",
  sendMessages: "can_send_messages",
  grantAccess: "is_admin",
};

// The write grants are exercised INSIDE Match Ops, so they also need the section they live in.
// EDIT CREDITS is deliberately not one of them: adjusting a balance is not a Match Ops power and
// must not arrive as a side effect of a read grant.
const NEEDS_MATCHOPS: ReadonlySet<Capability> = new Set<Capability>([
  "editMatches", "managePlayers", "managePromos",
]);

export const LABEL: Record<Capability, string> = {
  home: "Home", finance: "Finance", growth: "Player Lifecycle", membership: "Membership",
  matchops: "Match Ops", chats: "Chats", tech: "Tech", org: "Org",
  editMatches: "EDIT MATCHES", managePlayers: "MANAGE PLAYERS", managePromos: "MANAGE PROMOS",
  editCredits: "EDIT CREDITS", sendMessages: "SEND MESSAGES",
  grantAccess: "Admin",
};

// Keyed on EMAIL, not full_name — a machine account must never hold a write, whatever its row says.
import { isConfined, CONFINED_CAPABILITIES, CONFINED_ERROR, type ConfinableRow } from "./cityConfinement";

export const E2E_SERVICE_EMAIL = "clubhouse-e2e@playmatchday.com";

export { CONFINED_ERROR };

export const CITY_MANAGER_CONFINED_ERROR =
  "City manager accounts are scoped to their own city. Use Manager Pay, Reviews or Gameday Ops under /city.";

/** A city manager is confined to /city/* regardless of which boxes their row carries. */
export function isCityManagerConfined(row: CapRow | null | undefined): boolean {
  return !!row && row.is_city_manager === true && row.is_admin !== true;
}

/* THE CITY BOUNDARY, IMPORTED — not a third copy of a predicate. */
function confinedBlocks(row: CapRow | null | undefined, cap: Capability): boolean {
  if (!isConfined(row as ConfinableRow)) return false;
  // A confined account keeps EXACTLY the six pages' capabilities. It must NOT go down the
  // isCityManagerConfined path below, which returns false for everything — that path locks an
  // account out of Match Ops entirely, and these six pages ARE Match Ops.
  if (CONFINED_CAPABILITIES.has(cap)) return false;
  // Write grants still resolve on their own column. Confinement decides WHERE, not WHAT: it
  // neither grants a write nor revokes one, it scopes the data the write acts on. can_manage_promos
  // stays the only thing standing between this account and a 100%-off code, exactly as today.
  if (NEEDS_MATCHOPS.has(cap)) return false;
  return true;
}

function isServiceAccount(row: CapRow | null | undefined, email?: string | null): boolean {
  if (!row) return false;
  if (row.is_service_account === true) return true;
  const e = (email ?? (row.email as string | undefined) ?? "").toLowerCase();
  return e === E2E_SERVICE_EMAIL;
}

/**
 * Does this row hold the capability? THE FLAG DECIDES — there is no is_admin term.
 *
 * is_admin is NOT consulted as an extra requirement anywhere, and is only consulted as a
 * SUFFICIENT condition for the page-access flags, which is how it has always behaved: an admin
 * opening a page they hold no box for is not a privilege escalation, it is the tool working. What
 * changed is that the flag alone is now enough for everyone else.
 */
export function can(row: CapRow | null | undefined, cap: Capability, email?: string | null): boolean {
  if (!row) return false;
  if (isServiceAccount(row, email)) return false;
  if (isCityManagerConfined(row)) return false;
  // BEFORE the is_admin term below, and before grantAccess — the boundary beats the flag.
  if (confinedBlocks(row, cap)) return false;
  if (cap === "grantAccess") return row.is_admin === true;
  if (NEEDS_MATCHOPS.has(cap) && row.can_access_matchops !== true) return false;
  if (row[COLUMN[cap]] === true) return true;
  // is_admin remains sufficient for PAGE access only — never for a write grant, which must be
  // ticked explicitly even for an admin so the grid says what is true.
  // is_admin is sufficient for page access — but NOT inside a boundary. confinedBlocks() has
  // already returned true for every page outside the six, so this line cannot widen one.
  return !NEEDS_MATCHOPS.has(cap) && cap !== "editCredits" && cap !== "sendMessages"
    && row.is_admin === true;
}

/** The refusal, in the words the person needs — used by the route AND the panel. */
export function denial(row: CapRow | null | undefined, cap: Capability, email?: string | null): string | null {
  if (can(row, cap, email)) return null;
  if (!row) return "Not a cockpit user.";
  if (isServiceAccount(row, email)) return "Service accounts hold no permissions.";
  if (isCityManagerConfined(row)) return CITY_MANAGER_CONFINED_ERROR;
  if (confinedBlocks(row, cap)) return CONFINED_ERROR;
  if (NEEDS_MATCHOPS.has(cap) && row.can_access_matchops !== true) {
    return `${LABEL[cap]} is exercised inside Match Ops — you need Match Ops access as well.`;
  }
  return `${LABEL[cap]} is required. Ask an admin to tick it on the User access screen.`;
}

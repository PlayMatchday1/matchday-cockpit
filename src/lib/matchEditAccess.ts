// THE MATCH-EDIT RULE — now a thin read of capabilities.ts, which the route calls too.
//
// This file used to restate the gate (is_admin AND can_edit_matches AND can_access_matchops) and
// was pinned to the route by an equivalence assertion, because authenticateAdmin could not hand
// its row to a shared helper. That is gone: the route authenticates on the "editMatches"
// capability and the panel asks `can()` for the same one. Same function, no proxy.
//
// The is_admin term is gone with it. A ticked EDIT MATCHES box is now sufficient, which is what
// the box has always claimed.

import { can, denial, type CapRow } from "./capabilities";

export type MatchEditRow = CapRow;
export type MatchEditAccess = { ok: true } | { ok: false; reason: string };

export const NO_EDIT_MATCHES =
  "EDIT MATCHES is required to change matches. Ask an admin to tick it on the User access screen.";

export function matchEditAccess(row: MatchEditRow | null | undefined): MatchEditAccess {
  if (can(row, "editMatches", (row?.email as string | undefined) ?? null)) return { ok: true };
  return { ok: false, reason: denial(row, "editMatches", (row?.email as string | undefined) ?? null) ?? NO_EDIT_MATCHES };
}

export function mayEditMatch(row: MatchEditRow | null | undefined): boolean {
  return matchEditAccess(row).ok;
}

// MAY THIS PERSON EDIT A MATCH — one definition, read by the route that enforces it and the panel
// that offers the controls.
//
// WHY IT IS ONE FUNCTION. The panel used to check nothing at all: Save was disabled only on
// `unsaved === 0 || saving`. So a holder of EDIT MATCHES who is not an admin could open the panel,
// change 24 fields, click Save, and get back "Admin access required" — a permission the grant
// screen never offered, contradicting the EDIT MATCHES checkbox it shows as ticked. The panel was
// offering a write it could have known would be refused.
//
// The obvious fix — re-state the rule in the component — is how this class of bug keeps happening:
// two copies of a permission rule drift, and the copy in the UI is the one nobody notices is wrong.
// So the rule lives here, the panel reads it, and an equivalence test pins it to the route's
// real gates — see the note below.
//
// THIS ENCODES TODAY'S GATE, NOT A PREFERRED ONE. It mirrors, clause for clause:
//   route.ts:86  authenticateAdmin  → adminGate (adminAuth.ts:66): is_admin === true
//   route.ts:104 !auth.canEditMatches → deriveMatchOpsFlags (adminAuth.ts:53-58):
//                                       can_edit_matches === true && can_access_matchops === true
// If the gate is ever widened, this changes with it and the panel follows for free. Nothing here
// grants anything; it only describes what the route already does.
//
// THE ROUTE DOES NOT CALL THIS, AND THAT IS WORTH BEING HONEST ABOUT. authenticateAdmin does not
// return the app_users row, and this pass may not touch adminAuth.ts, so the route cannot hand its
// row in. Instead matchops-auth-test asserts, across every flag shape, that this predicate agrees
// EXACTLY with the route's real composition — adminGate(row).ok && deriveMatchOpsFlags(row)
// .canEditMatches. That equivalence test is the thing that stops the two drifting: change either
// side and it fails. It is a stronger guarantee than a shared call, because it exercises the gates
// the route actually runs rather than trusting that a shared helper is wired in.

export type MatchEditRow = {
  is_admin?: boolean | null;
  can_access_matchops?: boolean | null;
  can_edit_matches?: boolean | null;
};

export type MatchEditAccess = { ok: true } | { ok: false; reason: string };

// The requirement stated once, in the words the operator needs — naming EDIT MATCHES and admin
// together, because being told only "Admin access required" while holding EDIT MATCHES is exactly
// the contradiction that sent this to Ryan.
// The route's own 403 wording, exported so there is one copy of the sentence rather than two that
// drift apart the first time either is reworded.
export const NO_EDIT_MATCHES =
  "You have read-only Match Ops access. EDIT MATCHES is required to change matches.";

export const MATCH_EDIT_REQUIREMENT =
  "Editing a match needs EDIT MATCHES and admin. You hold EDIT MATCHES; the write also requires admin today.";

export function matchEditAccess(row: MatchEditRow | null | undefined): MatchEditAccess {
  if (!row) return { ok: false, reason: "Not a cockpit user." };
  // Match Ops read underpins both write flags (deriveMatchOpsFlags). Named first because it is the
  // one an operator can most usefully be told about.
  if (row.can_access_matchops !== true) {
    return { ok: false, reason: "Editing a match needs Match Ops access. Ask an admin to grant it." };
  }
  if (row.can_edit_matches !== true) return { ok: false, reason: NO_EDIT_MATCHES };
  // The clause that refuses Deonna. It is stated LAST so the message is about the one thing she is
  // missing, rather than the generic "Admin access required" the route returns from adminGate
  // before it has looked at any of the above.
  if (row.is_admin !== true) return { ok: false, reason: MATCH_EDIT_REQUIREMENT };
  return { ok: true };
}

/** Convenience for callers that only need the boolean. */
export function mayEditMatch(row: MatchEditRow | null | undefined): boolean {
  return matchEditAccess(row).ok;
}

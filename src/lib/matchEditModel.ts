// The ONE model behind the staging match editor: which fields are editable, how
// they're typed, and — critically — the single null-safe comparison that decides
// whether a field changed. The diff panel, the request builder, the server-side
// allowlist, and the tests all import `fieldChanged` from here, so they cannot
// drift. No "use client", no "server-only": shared by browser, route, and scripts.

// Fields editable through the match PUT (a proven partial update). NOT
// startDate/endDate (own action), scores/teamHomeId/teamAwayId (results), teams
// (separate endpoint), or id/updatedAt/relations.
export const EDITABLE_KEYS = [
  "name", "fieldId", "category", "type", "managerId", "secondManagerId", "description", "managerIntro",
  "registrationPrice", "additionalSpotPrice", "guestCount", "fakeSpotLeft36h", "fakeSpotLeft24h",
  "fakeSpotLeft12h", "fakeSpotLeft6h", "fakeSpotLeft3h", "autoCanceled", "autoCanceledMinutes",
  "minPlayerCount", "isFreeMember", "isAutoBump", "maxTeamSize2Team", "maxTeamSize4Team",
] as const;

export const MONEY_KEYS = new Set<string>(["registrationPrice", "additionalSpotPrice"]);
export const TOGGLE_KEYS = new Set<string>(["autoCanceled", "isFreeMember", "isAutoBump"]);
export const NULLABLE_NUM = new Set<string>(["managerId", "secondManagerId"]);

// Collapse "absence" to one canonical value. null, undefined and "" are the same
// absence for these fields — an empty text box is not a change from a stored null,
// and we must never send "" to overwrite a real null (or vice-versa). 0 and false
// are REAL values, not absence, so they are preserved and compared by value.
export function normValue(v: unknown): unknown {
  if (v === null || v === undefined || v === "") return null;
  return v;
}

// THE comparison. A field is changed only if the user's value would be a different
// value on the server. Used by the diff panel AND the request builder AND the
// tests — one definition, so they can never disagree.
export function fieldChanged(loadedVal: unknown, stateVal: unknown): boolean {
  return JSON.stringify(normValue(loadedVal)) !== JSON.stringify(normValue(stateVal));
}

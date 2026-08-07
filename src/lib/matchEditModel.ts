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
// Non-nullable numeric fields. Empty ("") or non-numeric input for one of these is
// NOT a value the user is committing — it must never enter the diff or the body.
export const NUMERIC_KEYS = new Set<string>([
  "registrationPrice", "additionalSpotPrice", "guestCount", "minPlayerCount", "autoCanceledMinutes",
  "maxTeamSize2Team", "maxTeamSize4Team", "fakeSpotLeft36h", "fakeSpotLeft24h", "fakeSpotLeft12h", "fakeSpotLeft6h", "fakeSpotLeft3h",
]);

// True when a value is not a usable number: "", null/undefined, NaN, or a string
// that doesn't parse. The editor stores "" for a cleared numeric input.
export function isBlankNumber(v: unknown): boolean {
  if (v === "" || v === null || v === undefined) return true;
  if (typeof v === "number") return Number.isNaN(v);
  return !Number.isFinite(Number(v));
}

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
// tests — one definition, so they can never disagree. Takes the key so numeric
// fields can be handled correctly: a blank/non-numeric numeric input is NOT a
// committed change (it never enters the diff, so pick(state, changed) can never
// put "" or NaN into the body — it would be a different, invalid "value").
export function fieldChanged(key: string, loadedVal: unknown, stateVal: unknown): boolean {
  if (NUMERIC_KEYS.has(key) && isBlankNumber(stateVal)) return false;
  return JSON.stringify(normValue(loadedVal)) !== JSON.stringify(normValue(stateVal));
}

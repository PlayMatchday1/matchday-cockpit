// THE "ALL TABS" PRESET (Ryan, 2026-11-07): one button on Admin → User access that opens every staff
// app tab across all cities, plus the two everyday writes. PURE: the route, the grid and the suite
// read these lists.
//
//   Health, Ops (Gameday, Lookup, Managers, Reviews)   Match Ops
//   Chats (Player chats, Match chats)                  Chats, and Send messages to reply
//   Goals                                              Growth
//   Players (Acquisition, Player activity)             Player Lifecycle
//   Match screen edits                                 Edit matches
//
// ADDITIVE, ON PURPOSE. It only turns these on. Admin, Edit credits, Edit memberships, Manage
// players, Manage promos and manager pay changes (can_change_manager_pay, 0260) are never turned on
// by it, and a box someone already holds is left as it is: those are per-person decisions.
// It is for an account with NO city: a city confines every tab, and the City manager preset is the
// one for city managers.

export const ALL_TABS_PRESET_ON = [
  "can_access_matchops", "can_edit_matches",
  "can_access_chats", "can_send_messages",
  "can_access_growth", "can_access_lifecycle",
] as const;

/** Never set by the preset; listed so the grid's hint and the suite name them. */
export const ALL_TABS_PER_PERSON = [
  "is_admin", "can_edit_credits", "can_edit_memberships", "can_manage_players", "can_manage_promos", "can_change_manager_pay",
] as const;

const hasCity = (row: Record<string, unknown>) => typeof row.city_identifier === "string" && row.city_identifier.trim().length > 0;

/** Who the preset is for: a person account with no city that is not a city manager. */
export function allTabsPresetRefusal(row: Record<string, unknown>): string | null {
  if (row.is_service_account === true) return "Service accounts hold no permissions.";
  if (row.is_city_manager === true) return "This account is a City Manager. Use the City manager preset; All tabs is across all cities.";
  if (hasCity(row)) return "This account is confined to one city. All tabs is across all cities: clear its city first if that is the intent.";
  return null;
}

export function holdsAllTabsPreset(row: Record<string, unknown>): boolean {
  return allTabsPresetRefusal(row) === null && ALL_TABS_PRESET_ON.every((k) => row[k] === true);
}

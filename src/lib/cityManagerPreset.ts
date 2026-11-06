// THE "CITY MANAGER" PRESET (Ryan, 2026-11-06): one button on Admin → User access that gives a city
// manager the staff app's city grants, each confined to their own city by the server
// (staffAppForward.ts, cityConfinement.ts). PURE: the route, the grid and the suite read these lists.
//
//   Gameday and match   Match Ops + Edit matches: Adjust, roster edits, manager change, cancel with a
//                       reason (every write re-checks the match's city: assertMatchInScope)
//   Chats               Chats + Send messages: their city's match chats and player chats
//   Lookup              Match Ops: players whose home city is theirs or who have played there
//   Goals               Growth: their city's Daily Matches
//   Players             Player Lifecycle: their market's Acquisition and Player activity rows
// Health, Managers week and Reviews need nothing new.
//
// OFF, ON PURPOSE: Edit credits (admin-only), Edit memberships, Manage players, Manage promos, and
// every desktop page flag. Admin and a city cannot coexist (city-manager route, rule 3).

export const CITY_MANAGER_PRESET_ON = [
  "can_access_matchops", "can_edit_matches",
  "can_access_chats", "can_send_messages",
  "can_access_lifecycle", "can_access_growth",
] as const;

export const CITY_MANAGER_PRESET_OFF = [
  "can_manage_players", "can_manage_promos", "can_edit_credits", "can_edit_memberships",
  "can_access_home", "can_access_finance", "can_access_membership", "can_access_tech", "can_access_org",
] as const;

/** The broad page flags a city manager may hold since 0256: exactly the preset's. */
export const CITY_MANAGER_ALLOWED_BROAD: readonly string[] = ["can_access_matchops", "can_access_chats", "can_access_lifecycle", "can_access_growth"];

/** The broad flags a city manager still may NOT hold (0256's CHECK). */
export const CITY_MANAGER_FORBIDDEN_BROAD: readonly string[] = ["is_admin", "can_access_home", "can_access_finance", "can_access_membership", "can_access_tech", "can_access_org"];

/** Does this row hold exactly the preset (on all on, all off off)? For the grid's label. */
export function holdsCityManagerPreset(row: Record<string, unknown>): boolean {
  return row.is_city_manager === true
    && CITY_MANAGER_PRESET_ON.every((k) => row[k] === true)
    && CITY_MANAGER_PRESET_OFF.every((k) => row[k] !== true);
}

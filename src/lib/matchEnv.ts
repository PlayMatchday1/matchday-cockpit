// The environment each match editor targets, in ONE place. Every screen builds its
// request URL AND its env badge from the same constant here, so the badge and the
// request target can never disagree, and the drawer's "open full editor" link can
// tell whether it points at the same environment it is editing. Flip a value here
// and both the routing and the badge move together.
import type { BadgeEnv } from "./matchEnvBadge";

export const DRAWER_ENV: BadgeEnv = "production";
export const FULL_EDITOR_ENV: BadgeEnv = "production";

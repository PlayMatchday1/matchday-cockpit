// The environment each match editor targets, in ONE place. Every screen builds its
// request URL AND its env badge from the same constant here, so the badge and the
// request target can never disagree, and the drawer's "open full editor" link can
// tell whether it points at the same environment it is editing. Flip a value here
// and both the routing and the badge move together.
import type { BadgeEnv } from "./matchEnvBadge";

/* A LOCAL STAGING SWITCH, for testing writes that must never touch a real match (cancels, 2026-11-01).
 * Honoured only under `next dev` AND with NEXT_PUBLIC_DEV_MATCH_ENV=staging; a production build has
 * NODE_ENV "production", so this is always "production" there and the branch is dropped. */
const LOCAL_STAGING = process.env.NODE_ENV === "development" && process.env.NEXT_PUBLIC_DEV_MATCH_ENV === "staging";

export const DRAWER_ENV: BadgeEnv = LOCAL_STAGING ? "staging" : "production";
export const FULL_EDITOR_ENV: BadgeEnv = LOCAL_STAGING ? "staging" : "production";

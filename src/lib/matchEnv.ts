// The environment each match editor targets, in ONE place. Every screen builds its
// request URL AND its env badge from the same constant here, so the badge and the
// request target can never disagree, and the drawer's "open full editor" link can
// tell whether it points at the same environment it is editing. Flip a value here
// and both the routing and the badge move together.
import type { BadgeEnv, DrawerEnv } from "./matchEnvBadge";

/* TWO DEV-ONLY SWITCHES, both dropped from a production build (NODE_ENV "production" there).
 * LOCAL_STAGING (cancels, 2026-11-01): NEXT_PUBLIC_DEV_MATCH_ENV=staging sends the drawer AND the full editor to
 * staging, for testing writes that must never touch a real match.
 * LOCAL_PAGES (field covers, 2026-10-18; server side: src/lib/localMode.ts): NEXT_PUBLIC_MATCHDAY_LOCAL_API=1 sends the
 * Gameday Ops board and its match panel to the LOCAL backend. The server refuses "local" unless its own local mode is
 * on, so the two cannot disagree into a production write. The full editor stays off local.
 * With both set, local wins for the drawer: it is the one that cannot reach a real match. */
const DEV = process.env.NODE_ENV === "development";
const LOCAL_STAGING = DEV && process.env.NEXT_PUBLIC_DEV_MATCH_ENV === "staging";
export const LOCAL_PAGES = DEV && process.env.NEXT_PUBLIC_MATCHDAY_LOCAL_API === "1";
export const DRAWER_ENV: DrawerEnv = LOCAL_PAGES ? "local" : LOCAL_STAGING ? "staging" : "production";
export const FULL_EDITOR_ENV: BadgeEnv = LOCAL_STAGING ? "staging" : "production";

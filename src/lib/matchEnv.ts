// The environment each match editor targets, in ONE place. Every screen builds its
// request URL AND its env badge from the same constant here, so the badge and the
// request target can never disagree, and the drawer's "open full editor" link can
// tell whether it points at the same environment it is editing. Flip a value here
// and both the routing and the badge move together.
import type { BadgeEnv, DrawerEnv } from "./matchEnvBadge";

/* LOCAL MODE, CLIENT SIDE (server side: src/lib/localMode.ts). The Gameday Ops board and its match panel read and edit
 * the LOCAL backend instead of production. Both conditions are inlined at build time: only `next dev` with
 * NEXT_PUBLIC_MATCHDAY_LOCAL_API=1 in a local env file turns it on, and a Vercel build has neither. The server refuses
 * the "local" environment unless its own local mode is on, so the two cannot disagree into a production write.
 * The full editor (FULL_EDITOR_ENV) and every other screen stay on production. */
export const LOCAL_PAGES = process.env.NEXT_PUBLIC_MATCHDAY_LOCAL_API === "1" && process.env.NODE_ENV === "development";
export const DRAWER_ENV: DrawerEnv = LOCAL_PAGES ? "local" : "production";
export const FULL_EDITOR_ENV: BadgeEnv = "production";

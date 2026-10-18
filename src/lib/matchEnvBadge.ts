// The environment badge shown on an editor, DERIVED from the environment that
// editor actually targets — never a constant string, never a parent prop. A screen
// passes the SAME env value it builds its request URL from, so the badge and the
// request target cannot disagree. Production is visually distinct and unmistakable
// (its own tone + a "LIVE" label), not a colour swap on the same text.

export type BadgeEnv = "staging" | "production";
/** The Gameday Ops board and match panel only: they also run against the local backend in local mode. */
export type DrawerEnv = BadgeEnv | "local";

export function envBadge(env: DrawerEnv): { label: string; tone: "prod" | "stage" } {
  return env === "production"
    ? { label: "PRODUCTION — LIVE EDITS", tone: "prod" }
    : env === "local"
      ? { label: "LOCAL · SEED DATA (localhost)", tone: "stage" }
      : { label: "STAGING · GUARDED", tone: "stage" };
}

// The environment badge shown on an editor, DERIVED from the environment that
// editor actually targets — never a constant string, never a parent prop. A screen
// passes the SAME env value it builds its request URL from, so the badge and the
// request target cannot disagree. Production is visually distinct and unmistakable
// (its own tone + a "LIVE" label), not a colour swap on the same text.

export type BadgeEnv = "staging" | "production";

export function envBadge(env: BadgeEnv): { label: string; tone: "prod" | "stage" } {
  return env === "production"
    ? { label: "PRODUCTION — LIVE EDITS", tone: "prod" }
    : { label: "STAGING · GUARDED", tone: "stage" };
}

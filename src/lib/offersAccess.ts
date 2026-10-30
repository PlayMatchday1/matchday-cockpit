// WHO MAY USE GROWTH › OFFERS until it ships: an allowlist ON TOP OF the admin check and the
// local-mode guard, never instead of them (Ryan, 2026-10-29: allowlisted to him until release).
//
//   OFFERS_ALLOWLIST=rmancuso@playmatchday.com
//
// Comma-separated emails, case and whitespace ignored. UNSET OR EMPTY MEANS NOBODY: the gate fails
// closed. Server-only by intent: read from process.env on each request and never sent to the
// browser, which only learns its own yes or no from GET /api/offers/access.

export function parseAllowlist(raw: string | undefined | null): Set<string> {
  return new Set((raw ?? "").split(",").map((s) => s.trim().toLowerCase()).filter((s) => s.includes("@")));
}

export function onOffersAllowlist(email: string | null | undefined, env: Record<string, string | undefined> = process.env): boolean {
  if (!email) return false;
  return parseAllowlist(env.OFFERS_ALLOWLIST).has(email.trim().toLowerCase());
}

// What a caller off the list gets: the same answer as a route that does not exist.
export const OFFERS_NOT_FOUND = { error: "Not found" } as const;

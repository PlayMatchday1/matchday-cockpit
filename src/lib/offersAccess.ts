// WHO MAY USE GROWTH › OFFERS: anyone with Match Ops access, decided on the server by offersGate
// (src/lib/offersServer.ts), which uses the Match Ops section's own check. These are the answers.

// What a signed-in person without access gets: the same answer as a route that does not exist.
export const OFFERS_NOT_FOUND = { error: "Not found" } as const;

// WHAT THE PAGE SHOWS for an answer from GET /api/offers/access. A 401 is NOT "you may not see this":
// it means the sign-in has ended (Supabase revoked the session; the browser still holds a token that
// looks valid until it expires), and drawing a 404 for it hides the real problem. So 401 is its own
// answer, "signin". Everything else that is not a 200 { allowed: true } is still no.
export type OffersAccessState = "yes" | "no" | "signin";
export function offersAccessState(status: number, json: unknown): OffersAccessState {
  if (status === 401) return "signin";
  return status === 200 && (json as { allowed?: unknown } | null)?.allowed === true ? "yes" : "no";
}

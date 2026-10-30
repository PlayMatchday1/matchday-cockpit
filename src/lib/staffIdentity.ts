// WHO DID IT. The Clubhouse writes to the backend as one shared service account, so every Offers
// write also carries the real person (backend feature/offers, docs/offers/M3-ENDPOINTS.md):
//
//   X-Acting-Staff-Email: <the signed-in Clubhouse user's email, lowercased>
//
// The email comes from the SERVER-SIDE SESSION ONLY (offersGate's authenticateAdmin), never from the
// browser, a body or a query string. Reads do not send it. Ported from the Match Manager branch.

// The backend's own rule (staff-identity.ts): an email, at most 255 characters, stored lowercased.
// Anything else is no identity at all, and the proxy refuses the write before it leaves.
export function staffEmailOf(sessionEmail: string | null | undefined): string | null {
  const e = (sessionEmail ?? "").trim().toLowerCase();
  return e.length > 0 && e.length <= 255 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

export const WHO_ARE_YOU = "Couldn't confirm who you are. Sign in again.";
export const STAFF_NOT_ALLOWED_PLAIN = "Something went wrong on our side and nothing was saved. Try again, and tell Ryan if it keeps happening.";

// The backend's three refusals. STAFF_EMAIL_NOT_ALLOWED means the backend did not see our sign-in as
// a service account: it should never happen from the Clubhouse, so the caller logs it.
export function staffErrorKind(text: string): "WHO" | "NOT_ALLOWED" | null {
  if (/STAFF_EMAIL_REQUIRED|INVALID_STAFF_EMAIL/.test(text)) return "WHO";
  if (/STAFF_EMAIL_NOT_ALLOWED/.test(text)) return "NOT_ALLOWED";
  return null;
}

// WHO DID IT (backend 6cce3f3, Ryan 2026-10-13). The Clubhouse writes to the backend as one shared
// service account, so every write the /api/mm proxy forwards also carries the real person:
//
//   X-Acting-Staff-Email: <the signed-in Clubhouse user's email, lowercased>
//
// The email comes from the SERVER-SIDE SESSION ONLY (mmAdminGate's authenticateAdmin), never from
// the browser, a body or a query string. It goes on EVERY write; the backend uses it on the ten
// routes that store a staff email and ignores it on the rest, so there is no per-route list here.
// Reads do not send it.
//
// Client-safe and pure: the server half (mmAdminServer) and the panels both use it.

export const STAFF_HEADER = "X-Acting-Staff-Email";

// The backend's own rule (staff-identity.ts): an email, at most 255 characters, stored lowercased.
// Anything else is no identity at all, and the proxy refuses the write before it leaves.
export function staffEmailOf(sessionEmail: string | null | undefined): string | null {
  const e = (sessionEmail ?? "").trim().toLowerCase();
  return e.length > 0 && e.length <= 255 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

export const WHO_ARE_YOU = "Couldn't confirm who you are. Sign in again.";
export const STAFF_NOT_ALLOWED_PLAIN = "Something went wrong on our side and nothing was saved. Try again, and tell Ryan if it keeps happening.";

// The backend's three refusals, in plain words. STAFF_EMAIL_NOT_ALLOWED means the backend did not
// see our sign-in as a service account; it should never happen from the Clubhouse, so the caller
// logs it and the person sees a generic line. Null: not one of these.
export function staffErrorKind(text: string): "WHO" | "NOT_ALLOWED" | null {
  if (/STAFF_EMAIL_REQUIRED|INVALID_STAFF_EMAIL/.test(text)) return "WHO";
  if (/STAFF_EMAIL_NOT_ALLOWED/.test(text)) return "NOT_ALLOWED";
  return null;
}

// Staff we know by name. Anyone else shows as their full email.
export const KNOWN_STAFF: Record<string, string> = {
  "rmancuso@playmatchday.com": "Ryan Mancuso",
};

// Who did something, for a panel: the staff email when the backend has one (the real person behind
// the service account), else the backend user's name. `title` is the hover text (the full email).
export type WhoDid = { label: string; title?: string };
export function whoDid(staffEmail: string | null | undefined, by?: { name: string } | null): WhoDid | null {
  const e = staffEmail?.trim().toLowerCase();
  if (e) return { label: KNOWN_STAFF[e] ?? e, title: e };
  const n = by?.name?.trim();
  return n ? { label: n } : null;
}

// PLAYERS IN THIS AREA — the shape of one row and the Klaviyo CSV. Pure: shared by the admin-only
// route (/api/growth/locations/players), which builds the rows, and the Map tab, which filters and
// exports them.
//
// CONTACT DETAILS COME FROM mdapi_users (email, phone_number, first_name, last_name, is_member) —
// Supabase, never MatchDay. MEMBER is mdapi_users.is_member, the flag Player Finder filters on; it
// can disagree with mdapi_subscriptions ACTIVE (docs/matchday-api-facts.md, "is_member = 397").

import { ACTIVITY_LABEL, type Activity } from "./wherePlayed";
import type { Reach } from "./locationsMap";

export type AreaPlayer = {
  id: number;
  firstName: string | null;
  lastName: string | null;
  /** Null for a deleted (scrubbed) account: its stored address is a tombstone, not a contact. */
  email: string | null;
  /** As stored; null for a scrubbed account. */
  phone: string | null;
  /** E.164 (+15125551234), or null when the stored number cannot be read as one. */
  phoneE164: string | null;
  area: string;
  zip: string | null;
  /** In market: the MatchDay city. Outside coverage: the place from their area label. */
  city: string | null;
  state: string | null;
  verdict: "in_market" | "waitlist";
  cityId: number | null;
  lastPlayed: string | null;
  activity: Activity;
  matches: number;
  favouriteField: string | null;
  member: boolean;
  keys: { nat: string; natAct: string; city: string | null; cityAct: string | null };
  fieldReach: Record<number, Reach>;
  /** Placed at their zip's Census centre because MatchDay sent no coordinates. */
  fromZip: boolean;
};

/* A DELETED ACCOUNT IS SCRUBBED IN PLACE: "Deleted" / "Account", phone null, email a tombstone at
 * playmatchday.com. The name pair is the marker (docs/matchday-api-facts.md, "A DELETED PLAYER IS
 * SCRUBBED IN PLACE"); the same rule as Player Finder's shape(). */
export const isScrubbed = (first: string | null, last: string | null) =>
  (first ?? "").trim() === "Deleted" && (last ?? "").trim() === "Account";

/** E.164 from what MatchDay stores. Already "+<8–15 digits>" passes through; a bare US 10-digit or
 *  1+10-digit number gets +1. Anything else is not guessed at. */
export function toE164(raw: string | null): string | null {
  if (!raw) return null;
  const t = raw.trim();
  const d = t.replace(/[^\d]/g, "");
  if (t.startsWith("+")) return d.length >= 8 && d.length <= 15 ? `+${d}` : null;
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return null;
}

export const KLAVIYO_HEADER = [
  "first_name", "last_name", "email", "phone_number", "zip", "city", "state",
  "last_played", "activity_bucket", "matches_played", "favourite_field", "member",
] as const;

/* A CELL THAT STARTS WITH = + - @ IS A FORMULA in a spreadsheet. Names and field titles are guarded
 * with a leading apostrophe; the phone is NOT, because E.164 starts with + and Klaviyo needs it as is. */
const safe = (s: string | null) => (s == null ? "" : /^[=+\-@]/.test(s) ? `'${s}` : s);

export function klaviyoRows(rows: AreaPlayer[]): string[][] {
  return [
    [...KLAVIYO_HEADER],
    ...rows.map((r) => [
      safe(r.firstName), safe(r.lastName), r.email ?? "", r.phoneE164 ?? "", r.zip ?? "", safe(r.city), r.state ?? "",
      r.lastPlayed ?? "", ACTIVITY_LABEL[r.activity], String(r.matches), safe(r.favouriteField), r.member ? "true" : "false",
    ]),
  ];
}

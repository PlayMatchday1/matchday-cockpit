// Pure logic for the Cities → Fields management page. No supabase, no
// React — everything here is unit-tested, because the page writes to the
// CANONICAL fin_venues record and a bug would corrupt the same row
// Finance bills from.
//
// The load-bearing rules:
//   • City Manager is DERIVED from the venue's city (city_managers
//     roster), never stored on the venue — so it can't drift.
//   • The save payload NEVER contains a City Manager field.
//   • Delete is soft-deactivation (is_active=false), never a hard delete,
//     so match / cost / schedule history is never orphaned.

import { CITIES, type City } from "./types";

// The label shown when a city has no manager in the roster (Atlanta,
// El Paso today).
export const UNASSIGNED_CITY_MANAGER = "Unassigned";

// city → manager_name, straight from the city_managers table. Missing
// entry → the city has no manager.
export type CityManagerRoster = Map<string, string>;

// The one place city→CM resolution happens. Everything (group headers,
// the modal chip) reads through this so the derived value is identical
// everywhere and can never be typed in by hand.
export function cityManagerFor(
  city: string | null | undefined,
  roster: CityManagerRoster,
): string {
  if (!city) return UNASSIGNED_CITY_MANAGER;
  return roster.get(city) ?? UNASSIGNED_CITY_MANAGER;
}

// The canonical city options for the select — the same list the rest of
// the app uses (lib/types CITIES), so City can never be free-texted into
// a new value that drifts from fin_venues.city.
export function cityOptions(): readonly City[] {
  return CITIES;
}

export function isKnownCity(city: string): city is City {
  return (CITIES as readonly string[]).includes(city);
}

// http(s) URL validation for the Schedule (Google Drive) link. Rejects
// non-URLs, bare text, and non-web schemes (mailto:, javascript:, ...).
// An empty string is allowed by the field itself (optional) — this
// validates only a NON-empty value, so call it after the required check.
export function isValidHttpUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return false;
  }
  return u.protocol === "http:" || u.protocol === "https:";
}

// The "Field Contact" value can be a phone number OR an email. Resolve it
// to a clickable link: emails → mailto:, phones → tel: (sanitized to a
// dialable string — digits, with a leading + preserved for international).
// Returns null when the value is empty or has nothing dialable/emailable,
// so the UI renders it as plain text rather than a dead link.
export type ContactLink = { href: string; kind: "email" | "phone" };

export function contactLink(
  value: string | null | undefined,
): ContactLink | null {
  if (!value) return null;
  const v = value.trim();
  if (!v) return null;
  if (v.includes("@")) {
    // Loose email check — must have something either side of the @.
    const [local, domain] = v.split("@");
    if (!local || !domain || !domain.includes(".")) return null;
    return { href: `mailto:${v}`, kind: "email" };
  }
  const plus = v.startsWith("+") ? "+" : "";
  const digits = v.replace(/\D/g, "");
  if (!digits) return null;
  return { href: `tel:${plus}${digits}`, kind: "phone" };
}

// Parse a player-count input to an integer, or null. STRICT: only whole
// numbers ≥ 0. Rejects floats ("12.5"), non-numeric text, and negatives
// — min/max players accept ints only. Empty → null (the field is
// optional). Returns { ok, value } so the caller can distinguish "blank"
// (ok, null) from "invalid" (not ok).
export function parseIntStrict(
  raw: string | number | null | undefined,
): { ok: boolean; value: number | null } {
  if (raw == null || raw === "") return { ok: true, value: null };
  const s = String(raw).trim();
  if (s === "") return { ok: true, value: null };
  // Whole number only: optional sign not allowed (counts are ≥ 0).
  if (!/^\d+$/.test(s)) return { ok: false, value: null };
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0) return { ok: false, value: null };
  return { ok: true, value: n };
}

// Raw form state from the Add/Edit modal. Note there is NO cityManager
// field — CM is derived, never entered. (Field Name / field_name was
// removed — we keep a single name, "Field" = venue_name.)
export type FieldFormInput = {
  venue_name: string; // "Field" (short internal name)
  city: string;
  contact_name: string; // "Field Contact Name" — column stays contact_name
  contact_number: string; // "Field Contact Number" — column stays contact_number
  min_players: string;
  max_players: string;
  schedule_url: string;
};

// The validated, DB-ready payload written to fin_venues. Deliberately has
// no City Manager key — a compile-time guarantee CM is never persisted on
// the venue. No field_name key — that column is retired (see migration
// 0075); nothing in the payload touches it.
export type FieldPayload = {
  venue_name: string;
  city: string;
  contact_name: string | null;
  contact_number: string | null;
  min_players: number | null;
  max_players: number | null;
  schedule_url: string | null;
};

export type ValidationResult =
  | { ok: true; payload: FieldPayload }
  | { ok: false; error: string };

// Validate + normalize the modal form into a fin_venues payload.
// Required: Field (venue_name) and a known City. Optional everything
// else; blanks persist as null. min/max must be ints; schedule_url, if
// present, must be an http(s) URL.
export function buildFieldPayload(input: FieldFormInput): ValidationResult {
  const venue_name = input.venue_name.trim();
  if (!venue_name) return { ok: false, error: "Field (short name) is required." };

  const city = input.city.trim();
  if (!city) return { ok: false, error: "City is required." };
  if (!isKnownCity(city)) {
    return { ok: false, error: `"${city}" is not a known city.` };
  }

  const min = parseIntStrict(input.min_players);
  if (!min.ok) return { ok: false, error: "Min Players must be a whole number." };
  const max = parseIntStrict(input.max_players);
  if (!max.ok) return { ok: false, error: "Max Players must be a whole number." };
  if (min.value != null && max.value != null && min.value > max.value) {
    return { ok: false, error: "Min Players can't exceed Max Players." };
  }

  const scheduleRaw = input.schedule_url.trim();
  if (scheduleRaw && !isValidHttpUrl(scheduleRaw)) {
    return {
      ok: false,
      error: "Schedule link must be a valid http(s) URL.",
    };
  }

  const orNull = (s: string) => (s.trim() ? s.trim() : null);
  return {
    ok: true,
    payload: {
      venue_name,
      city,
      contact_name: orNull(input.contact_name),
      contact_number: orNull(input.contact_number),
      min_players: min.value,
      max_players: max.value,
      schedule_url: scheduleRaw || null,
    },
  };
}

// Delete strategy. We NEVER hard-delete a venue: fin_venues is referenced
// by matches (via fin_venue_fields.mdapi_field_id), cost overrides,
// partner dashboards, and projections. Deleting would orphan or block on
// FKs. "Delete" is always a soft-deactivation, which preserves all that
// history and simply drops the venue from active lists.
export type DeleteAction = { mode: "soft-deactivate"; patch: { is_active: false } };

export function resolveDeleteAction(): DeleteAction {
  return { mode: "soft-deactivate", patch: { is_active: false } };
}

// "DOWNLOAD PLAYERS" ON THE ACQUISITION PAGE (Ryan, 2026-10-21) — pure (no Supabase, no fetch).
//
// One row per account the Registrations card counts for the range, and nothing else: the ROW SET is
// growth_account with the card's own predicate (status 'counted', completed_sign_up_at set, its
// America/Chicago day inside the range; migration 0208, growth_acquisition_daily). The route checks
// the row count against the card's sum and refuses the file if they differ, so the two cannot drift.
//
// WHAT COMES FROM WHERE
//   ID, city, Warsaw, signup completed   growth_account (the card's view)
//   names, email, phone, soccer level    the LIVE player (GET /admin/players/{id}), else the mirror
//   verified by                          the LIVE player only: emailVerifiedAt is on the detail payload
//                                        and never in mdapi_users.raw (docs/matchday-api-facts.md,
//                                        "GET /admin/players HIDES ACCOUNTS WITH emailVerifiedAt NULL")
//   deleted                              live first: 9 of 18 deleted accounts in Oct 12-18 were not yet
//                                        scrubbed in the mirror (probed 2026-10-21), so the mirror alone
//                                        would have put a deleted person's real address in the file.
// A deleted account gets blank email and phone, and the name MatchDay gives it ("Deleted Account").

import { E2E_SERVICE_EMAIL } from "@/lib/matchOpsAuth";

export type CountedAccount = { account_id: number; completed_sign_up_at: string; declared_city_raw: string | null };
export type MirrorUser = { id: number; email: string | null; first_name: string | null; last_name: string | null; phone_number: string | null; raw: Record<string, unknown> | null };
/** The fields read off GET /admin/players/{id}; null when the lookup failed. */
export type LivePlayer = {
  email: string | null; firstName: string | null; lastName: string | null; phoneNumber: string | null;
  emailVerifiedAt: string | null; phoneNumberVerifiedAt: string | null; selfRatingValue: number | null;
};

export type SignupRow = {
  id: number; firstName: string; lastName: string; email: string; phone: string; city: string;
  completedCentral: string; verifiedBy: "email" | "phone" | "both" | "neither" | "unknown";
  level: string; deleted: boolean; warsaw: boolean;
};

const TOMB = /^del_[0-9a-f]{40}@playmatchday\.com$/;
export const isTombstone = (email: string | null | undefined, first?: string | null, last?: string | null) =>
  TOMB.test((email ?? "").trim().toLowerCase()) || (first === "Deleted" && last === "Account");

/** The card's day: the America/Chicago calendar day of the completed signup. */
export const chicagoYmdOfInstant = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date(iso));

/** "2026-10-14 18:05" in Central time (DST-aware). */
export function centralDateTime(iso: string): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

export function verifiedBy(live: LivePlayer | null): SignupRow["verifiedBy"] {
  if (!live) return "unknown";
  const e = !!live.emailVerifiedAt, p = !!live.phoneNumberVerifiedAt;
  return e && p ? "both" : e ? "email" : p ? "phone" : "neither";
}

/** The card's predicate, applied to growth_account rows already filtered to status 'counted'. */
export const inRange = (a: { completed_sign_up_at: string | null }, since: string, until: string) => {
  if (!a.completed_sign_up_at) return false;
  const d = chicagoYmdOfInstant(a.completed_sign_up_at);
  return d >= since && d <= until;
};

export function buildSignupRows(accounts: readonly CountedAccount[], mirror: ReadonlyMap<number, MirrorUser>, live: ReadonlyMap<number, LivePlayer | null>): SignupRow[] {
  return [...accounts]
    .sort((a, b) => a.completed_sign_up_at.localeCompare(b.completed_sign_up_at) || a.account_id - b.account_id)
    .map((a) => {
      const m = mirror.get(a.account_id) ?? null, l = live.get(a.account_id) ?? null;
      const deleted = l ? isTombstone(l.email, l.firstName, l.lastName) || isTombstone(m?.email) : isTombstone(m?.email, m?.first_name, m?.last_name);
      const lvl = l?.selfRatingValue ?? (typeof m?.raw?.selfRatingValue === "number" ? (m.raw.selfRatingValue as number) : null);
      return {
        id: a.account_id,
        firstName: (l ? l.firstName : m?.first_name) ?? "",
        lastName: (l ? l.lastName : m?.last_name) ?? "",
        email: deleted ? "" : ((l ? l.email : m?.email) ?? ""),
        phone: deleted ? "" : ((l ? l.phoneNumber : m?.phone_number) ?? ""),
        city: a.declared_city_raw ?? "",
        completedCentral: centralDateTime(a.completed_sign_up_at),
        verifiedBy: verifiedBy(l),
        level: lvl == null ? "" : String(lvl),
        deleted,
        warsaw: a.declared_city_raw === "Warsaw",
      };
    });
}

export const SIGNUP_COLUMNS = [
  "ID", "First name", "Last name", "Email", "Phone number", "City",
  "Signup completed (Central)", "Verified by", "Soccer level", "Deleted", "Warsaw",
] as const;

// A cell Excel would run as a formula (=, +, -, @, tab, CR) gets a leading apostrophe. Names and
// emails are typed by players, so the file must not execute what they typed. A phone number's
// leading "+" is part of the number, so a phone is exempt; it is digits and "+" only (checked).
function cell(v: string, isPhone = false): string {
  let s = v;
  if (isPhone && !/^\+?[0-9 ()-]*$/.test(s)) s = s.replace(/[^0-9+ ()-]/g, "");
  if (!isPhone && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** UTF-8 with a byte-order mark (so Excel reads "Taştan" correctly), CRLF line ends. */
export function signupCsv(rows: readonly SignupRow[]): string {
  const yn = (b: boolean) => (b ? "yes" : "no");
  const lines = [SIGNUP_COLUMNS.join(",")];
  for (const r of rows) {
    lines.push([
      String(r.id), cell(r.firstName), cell(r.lastName), cell(r.email), cell(r.phone, true), cell(r.city),
      r.completedCentral, r.verifiedBy, r.level, yn(r.deleted), yn(r.warsaw),
    ].join(","));
  }
  return "﻿" + lines.join("\r\n") + "\r\n";
}

export const signupFileName = (since: string, until: string) => `matchday-signups-${since}-to-${until}.csv`;

/** Who may download: admins only. The E2E service account and confined accounts never, whatever flags
 *  their rows carry (keyed on EMAIL as well as the flag, per CLAUDE.md "Permissions"). */
export function playerExportGate(row: Record<string, unknown> | null, email: string): { ok: true } | { ok: false; status: number; error: string } {
  if (!row) return { ok: false, status: 403, error: "Not a cockpit user" };
  if (email.toLowerCase() === E2E_SERVICE_EMAIL || row.is_service_account === true) return { ok: false, status: 403, error: "Service accounts cannot download players" };
  if (row.is_city_manager === true && row.is_admin !== true) return { ok: false, status: 403, error: "Admin access required" };
  if (row.is_admin !== true) return { ok: false, status: 403, error: "Admin access required" };
  return { ok: true };
}

/** The change_log body: who is on the row already; this is the range and the count. NEVER a player. */
export const signupExportLogBody = (since: string, until: string, rows: number, lookupFailures: number) =>
  ({ since, until, rows, lookup_failures: lookupFailures });

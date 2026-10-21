// "DOWNLOAD PLAYERS" ON THE ACQUISITION PAGE (Ryan, 2026-10-21) — pure (no Supabase, no fetch).
//
// One row per account the Registrations card counts for the range, and nothing else: the ROW SET is
// growth_account with the card's own predicate (status 'counted', completed_sign_up_at set, its
// America/Chicago day inside the range; migration 0208, growth_acquisition_daily). The route checks
// the row count against the card's sum and refuses the file if they differ, so the two cannot drift.
//
// WHAT COMES FROM WHERE — OUR COPY ONLY since 2026-10-21 (Ryan: no live per-player lookups; the first
// version read GET /admin/players/{id} for every row, 8 at a time, up to 5,000 a click).
//   ID, city, Warsaw, signup completed   growth_account (the card's view)
//   names, email, phone, soccer level    mdapi_users, kept current by the 3 AM Central full pass, which
//                                        also re-reads the accounts the list stopped returning
//                                        (playerAreaSync.ts, refreshUnlisted)
//   deleted                              yes: MatchDay's scrub is in our copy. unknown: the row was not
//                                        confirmed by the API since the last full refresh started
//                                        (or there is no row) — 9 of 18 deleted accounts in Oct 12-18
//                                        were exactly such rows, unscrubbed here (probed 2026-10-21).
// A deleted account gets blank email and phone, and the name MatchDay gives it ("Deleted Account").
// An UNCONFIRMED row gets blank name, email and phone: an address nobody can vouch for is not exported.
// "Verified by" was dropped (Ryan, 2026-10-21): emailVerifiedAt is on the detail payload only.

import { E2E_SERVICE_EMAIL } from "@/lib/matchOpsAuth";
import { STOP_RX, phoneDigits10 } from "@/lib/aiDraftModel";

// OPT-OUTS (Ryan, 2026-10-21).
//   Texts opted out   the player's phone (or a thread linked to the account) has a STOP-type reply in
//                     Player Chats (SMS or WhatsApp; aiDraftModel.STOP_RX, the same words the drafts
//                     treat as a stop) with no later START / UNSTOP on that thread. Carrier-level opt-outs
//                     held by Telnyx are NOT in our data, so "no" means "no STOP reply we hold".
//   Emails opted out  "unknown" on every row: Clubhouse holds no email unsubscribe data at all
//                     (no email provider table, nothing in the user payload; probed 2026-10-21).

export type CountedAccount = { account_id: number; completed_sign_up_at: string; declared_city_raw: string | null };
export type MirrorUser = { id: number; email: string | null; first_name: string | null; last_name: string | null; phone_number: string | null; raw: Record<string, unknown> | null; synced_at: string };

export type SignupRow = {
  id: number; firstName: string; lastName: string; email: string; phone: string; city: string;
  completedCentral: string; level: string; deleted: "yes" | "no" | "unknown"; warsaw: boolean; textsOptedOut: boolean;
};

export type ChatMsg = { thread_id: string; body: string; sent_at: string };
export type ChatThread = { id: string; phone_number: string | null; player_id: number | null };
const START_RX = /^\s*(start|unstop)\s*[.!]*\s*$/i;
const phoneKey = (s: string | null | undefined) => { const d = (s ?? "").replace(/\D/g, ""); return d ? phoneDigits10(d) ?? d : null; };

/** Phones and accounts whose LATEST stop/start keyword in Player Chats is a stop. */
export function textOptOuts(inbound: readonly ChatMsg[], threads: readonly ChatThread[]): { phones: Set<string>; players: Set<number> } {
  const last = new Map<string, { at: string; stop: boolean }>();
  for (const m of inbound) {
    const stop = STOP_RX.test(m.body), start = START_RX.test(m.body);
    if (!stop && !start) continue;
    const prev = last.get(m.thread_id);
    if (!prev || m.sent_at >= prev.at) last.set(m.thread_id, { at: m.sent_at, stop });
  }
  const phones = new Set<string>(), players = new Set<number>();
  for (const t of threads) {
    if (!last.get(t.id)?.stop) continue;
    const k = phoneKey(t.phone_number); if (k) phones.add(k);
    if (t.player_id != null) players.add(t.player_id);
  }
  return { phones, players };
}

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

/** The card's predicate, applied to growth_account rows already filtered to status 'counted'. */
export const inRange = (a: { completed_sign_up_at: string | null }, since: string, until: string) => {
  if (!a.completed_sign_up_at) return false;
  const d = chicagoYmdOfInstant(a.completed_sign_up_at);
  return d >= since && d <= until;
};

/** `confirmedSince`: when the last successful full refresh of mdapi_users started. A mirror row read
 *  after it was confirmed by the API; one read before it was not returned since (null = no refresh on
 *  record, so nothing is held to it). */
export function buildSignupRows(accounts: readonly CountedAccount[], mirror: ReadonlyMap<number, MirrorUser>, confirmedSince: string | null,
  optOuts: { phones: ReadonlySet<string>; players: ReadonlySet<number> } = { phones: new Set(), players: new Set() }): SignupRow[] {
  return [...accounts]
    .sort((a, b) => a.completed_sign_up_at.localeCompare(b.completed_sign_up_at) || a.account_id - b.account_id)
    .map((a) => {
      const m = mirror.get(a.account_id) ?? null;
      const tomb = !!m && isTombstone(m.email, m.first_name, m.last_name);
      const unconfirmed = !m || (confirmedSince != null && Date.parse(m.synced_at) < Date.parse(confirmedSince));
      const deleted: SignupRow["deleted"] = tomb ? "yes" : unconfirmed ? "unknown" : "no";
      const blankContact = deleted !== "no", blankName = deleted === "unknown";
      const lvl = typeof m?.raw?.selfRatingValue === "number" ? (m.raw.selfRatingValue as number) : null;
      return {
        id: a.account_id,
        firstName: blankName ? "" : (m?.first_name ?? ""),
        lastName: blankName ? "" : (m?.last_name ?? ""),
        email: blankContact ? "" : (m?.email ?? ""),
        phone: blankContact ? "" : (m?.phone_number ?? ""),
        city: a.declared_city_raw ?? "",
        completedCentral: centralDateTime(a.completed_sign_up_at),
        level: lvl == null ? "" : String(lvl),
        deleted,
        warsaw: a.declared_city_raw === "Warsaw",
        // Read before the blanking: a phone that said STOP stays opted out.
        textsOptedOut: optOuts.players.has(a.account_id)
          || (() => { const k = phoneKey(m?.phone_number); return !!k && optOuts.phones.has(k); })(),
      };
    });
}

export const SIGNUP_COLUMNS = [
  "ID", "First name", "Last name", "Email", "Phone number", "City",
  "Signup completed (Central)", "Soccer level", "Deleted", "Warsaw",
  "Texts opted out", "Emails opted out",
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
      r.completedCentral, r.level, r.deleted, yn(r.warsaw),
      yn(r.textsOptedOut), "unknown",
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
export const signupExportLogBody = (since: string, until: string, rows: number, unconfirmed: number) =>
  ({ since, until, rows, unconfirmed });

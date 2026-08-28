// ASSIGNING A MATCH MANAGER TO A MATCH — the pure model. No network, no clock, no Supabase.
//
// THIS WRITE DECIDES WHO GETS PAID. Manager Pay pays per match at $20/$30 keyed on
// max_player_count (managerPayCompute.payAmount, imported here rather than restated — a second
// copy of that rule is a second answer to "what does this match pay"). Attaching the wrong person
// is a wrong PAYMENT, not a wrong label, so the confirmation names the person, the match and the
// amount before anything is sent.
//
// ── WHAT MANAGER PAY ACTUALLY READS, MEASURED 2026-08-26 ──────────────────────────────────────
// The write sets `managerId`. Manager Pay groups on `mdapi_matches.manager_email` and keys its
// adjustments on that email — NOT on manager_id (managerPayCompute.ts, `if (m.manager_email)`).
// They are one source only because refreshMatchMirror rewrites manager_id AND manager_email AND
// the name from the SAME read-back payload whenever `managerId` is in the written keys. Measured
// on the mirror: 5,404 rows carry a manager_id, 5,404 carry a manager_email, ZERO have one without
// the other, and no manager_id maps to more than one email. So they do not drift today — but the
// thing that keeps them together is that one write-through, and a path that set manager_id without
// it would pay the previous person. That is the whole reason this write goes through the existing
// route rather than a new one.
//
// ── DETACH: PROVEN ON STAGING, NOT ASSUMED ────────────────────────────────────────────────────
// PUT has PATCH semantics and "clearing a box is not a change" is on our trap list, so all three
// candidate detach bodies were tried against staging match 3 and VERIFIED BY READING THE MATCH
// BACK:
//
//   { managerId: null }            -> DETACHED. read back managerId null, manager null.
//   { managerId: "" }              -> HTTP 400, rejected, DID NOT LAND. manager still attached.
//   field omitted entirely          -> NOT APPLIED. manager still attached (PATCH semantics).
//
// So unassign WORKS and stays enabled, `null` is the only body that detaches, and "" must never
// reach the wire — which matters because a cleared <select> yields "" and not null.

import { payAmount } from "./managerPayCompute";

export type ManagerOption = {
  id: number;
  name: string;
  /** True when this person is NOT on the match city's roster — offered only behind "show all". */
  offCity: boolean;
};

/** The one value that detaches. Never "", never undefined, never an omitted field. */
export const DETACH_VALUE = null;

export const DETACH_PROOF =
  "Verified on staging match 3 by reading the match back: managerId:null detaches, managerId:\"\" " +
  "is rejected 400, and omitting the field changes nothing.";

/**
 * A <select> value off the wire, turned into something safe to send.
 *
 * "" IS NOT A NUMBER AND IT IS NOT null. The API rejects it with a 400, and the editor stores ""
 * for a cleared control — so the mapping happens here, once, rather than at four call sites.
 * `"none"` is the picker's own sentinel for detach and maps to null deliberately.
 */
export function normalizeManagerId(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "" || raw === "none") return DETACH_VALUE;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DETACH_VALUE;
}

/**
 * THE DIFF IS THE REQUEST BODY. One key, always — never the whole match, never a field that did
 * not change. A caller that passes the value already on the match gets null back, because sending
 * a field to set it to what it already is is not a change and should not be a write.
 */
export function assignBody(next: number | null, current: number | null): { managerId: number | null } | null {
  const a = normalizeManagerId(next);
  const b = normalizeManagerId(current);
  if (a === b) return null;
  return { managerId: a };
}

/* ── THE PICKER ────────────────────────────────────────────────────────────────────────────────
 * DEFAULT TO THE MATCH'S CITY, WITH A VISIBLE ESCAPE. Measured on production: a typical Austin
 * fixture offers 28 of the 87 match managers by default; "show all cities" offers all 87. A
 * manager covering a one-off outside their listed cities is a real thing that happens, and
 * silently hiding them turns a real assignment into an impossible one — so the escape is a visible
 * control, and the people it reveals are LABELLED as off-city rather than mixed in unmarked.
 *
 * THE CURRENT MANAGER IS ALWAYS OFFERED, even when they are on neither list. A match already
 * attached to someone who has since left the city's roster must still render their name; dropping
 * them makes the control show a different person than the match has. */
export function pickerOptions(
  cityManagers: readonly { id: number; name: string }[],
  allManagers: readonly { id: number; name: string }[],
  showAll: boolean,
  current?: { id: number; name: string } | null,
): ManagerOption[] {
  const cityIds = new Set(cityManagers.map((m) => m.id));
  const base = showAll ? allManagers : cityManagers;
  const by = new Map<number, ManagerOption>();
  for (const m of base) by.set(m.id, { id: m.id, name: m.name, offCity: !cityIds.has(m.id) });
  if (current && current.id > 0 && !by.has(current.id)) {
    by.set(current.id, { id: current.id, name: current.name, offCity: !cityIds.has(current.id) });
  }
  return [...by.values()].sort((a, b) =>
    Number(a.offCity) - Number(b.offCity) || a.name.localeCompare(b.name) || a.id - b.id);
}

/* ONE NAME LOOKUP, SEARCHING BOTH LISTS, SHARED BY BOTH SURFACES. It used to search the city
 * roster only, so an off-city manager — and any manager who has since come off this city's roster
 * — rendered as "id 41207" in the diff and in the confirmation. A confirmation that names an id is
 * not naming a person. It lived in MatchPanel and Match editor had a near-identical private copy;
 * two lookups that agree today are two lookups that can disagree tomorrow, on a string an operator
 * reads before deciding who gets paid. */
export function managerNameIn(all: readonly { id: number; name: string }[], id: unknown): string {
  return all.find((m) => m.id === Number(id))?.name ?? (id == null || id === "" ? "\u2014" : `id ${id}`);
}

/** How many people the picker is offering, and how many it is holding back. */
export function offeredCounts(
  cityManagers: readonly { id: number }[],
  allManagers: readonly { id: number }[],
): { city: number; all: number; hidden: number } {
  const city = cityManagers.length, all = allManagers.length;
  return { city, all, hidden: Math.max(0, all - city) };
}

/* ── THE CONFIRMATION ──────────────────────────────────────────────────────────────────────────
 * IT NAMES THE PERSON AND THE MATCH, and it names the money, because that is what the write
 * decides. A yes/no on "Save changes?" is not a confirmation of this write — it is a confirmation
 * that something is about to happen. */
export type ConfirmInput = {
  matchName: string | null;
  whenText: string | null;          // already formatted by the caller — this module has no clock
  cityLabel: string | null;
  fromName: string | null;          // who is attached now, null when nobody is
  toName: string | null;            // who will be attached, null when detaching
  maxPlayerCount: number | null;
  coManaged: boolean;
  offCity: boolean;
};

export const centsish = (dollars: number) => `$${dollars}`;

export function confirmLines(c: ConfirmInput): string[] {
  const match = [c.matchName || "this match", c.whenText, c.cityLabel].filter(Boolean).join(" · ");
  const pay = payAmount(c.maxPlayerCount, c.coManaged);
  const out: string[] = [];
  if (c.toName === null) {
    out.push(`Detach ${c.fromName ?? "the current manager"} from ${match}.`);
    out.push(`Manager Pay stops paying ${centsish(pay)} for this match until someone is attached.`);
  } else if (c.fromName && c.fromName !== c.toName) {
    out.push(`Move ${match} from ${c.fromName} to ${c.toName}.`);
    out.push(`${centsish(pay)} moves from ${c.fromName} to ${c.toName} on the pay week this match falls in.`);
  } else {
    out.push(`Attach ${c.toName} to ${match}.`);
    out.push(`Manager Pay will pay ${c.toName} ${centsish(pay)} for this match.`);
  }
  if (c.offCity && c.toName) {
    out.push(`${c.toName} is not on this city's manager roster — this is an off-city assignment.`);
  }
  out.push("Sent once. It is never retried.");
  return out;
}

/* ── THIS IS THE MATCH-LEVEL WRITE, AND IT IS NOT THE ONLY ONE ─────────────────────────────────
 * Attaching an existing manager to a MATCH is what this module does. Adding a person to a CITY's
 * roster and removing them from it are SEPARATE endpoints that DO exist — POST /city-managers and
 * DELETE /city-managers?userId=&cityId=, both proven on staging — and Clubhouse has simply not
 * built those two yet. An earlier version of this comment said they did not exist; it was wrong,
 * because it was written from a grep for a guessed function name rather than from Retool's own
 * button. See matchManagers.ts. */
export const CAN_ASSIGN_MANAGER_TO_MATCH = true;
export const CAN_UNASSIGN_MANAGER_FROM_MATCH = true;
export const UNASSIGN_PROOF = DETACH_PROOF;

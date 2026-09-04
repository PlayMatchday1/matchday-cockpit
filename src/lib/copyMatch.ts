/* COPY A MATCH — the body, as a pure function. Nothing here fetches and nothing here writes.
 *
 * ── WHAT THE CREATE ROUTE ACCEPTS, MEASURED ───────────────────────────────────────────────────
 * CREATE_FIELDS is CREATE_REQUIRED (9) ∪ EDITABLE_KEYS (18 more) = 27 keys. It does NOT need
 * widening: it was widened on 2026-08-25, after production 18408 was copied with a nine-key body,
 * landed with no price because the API defaults an absent one to 0, and sold 44 spots at $0
 * against $15 siblings. Anything outside those 27 comes back "not creatable: <key>", so this
 * builds from the list rather than spreading the source match — a spread would fail loudly on
 * `id`, `players`, `teams`, `starRating` and the rest, which is safer than silent, but still a
 * failure the operator would have to read.
 *
 * ── WALL CLOCK, PASSED THROUGH UNTOUCHED ──────────────────────────────────────────────────────
 * startDate and endDate carry a Z they do not mean — they are LOCAL time at the pitch. They are
 * copied as STRINGS, byte for byte. No Date is constructed anywhere in this file and none may be
 * added: `new Date(m.startDate).toISOString()` re-shifts a 7pm match by the server's offset and
 * lands it on the wrong day.
 *
 * ── teamNumbers IS NOT AN EDITABLE KEY ────────────────────────────────────────────────────────
 * It is REQUIRED by the create route and absent from EDITABLE_KEYS, so it is not on the source
 * match as a field — it is the LENGTH of the teams array. Derived here, defaulting to 2, because
 * a create without it is a 400.
 *
 * ── WHAT IS DELIBERATELY NOT COPIED ───────────────────────────────────────────────────────────
 * The api id, the roster, and everything player-shaped: `players`, `_count`, `starRating`,
 * `starRatingCount`, `isCancelled`, `createdAt`, `updatedAt`. A copy is a new fixture, not a
 * clone of who turned up to the old one.
 */

import { EDITABLE_KEYS } from "./matchEditModel";

/** The 9 the API itself demands — measured on staging by omitting them. */
export const COPY_REQUIRED = [
  "name", "description", "type", "startDate", "endDate",
  "fieldId", "maxPlayerCount", "teamNumbers", "isFreeMember",
] as const;

/** Everything the create route accepts: the required 9 plus every editable field. */
export const COPY_FIELDS: readonly string[] = [
  ...COPY_REQUIRED,
  ...EDITABLE_KEYS.filter((k) => !(COPY_REQUIRED as readonly string[]).includes(k)),
];

/** Where a copy is going: a calendar date, and optionally a time that overrides the source's. */
export type CopyTarget = { iso: string; hhmm?: string };

/* ── RETARGETING, ON THE STRING ────────────────────────────────────────────────────────────────
 * The date and the time are SWAPPED INSIDE THE STRING. Same rule as the rest of this file and for
 * the same reason: startDate carries a Z it does not mean, and `new Date(m.startDate)` re-shifts a
 * 7pm match by the server's offset and lands it on the wrong day.
 *
 * `<input type="time">` hands back exactly the five characters this substitutes, so there is no
 * parsing and no formatting between the control and the write. */
export function retargetStart(s: string, targetIso: string, hhmm?: string): string {
  return `${targetIso}T${hhmm ?? s.slice(11, 16)}${s.slice(16)}`;
}

/* ── THE CALENDAR, AS INTEGERS. NO Date, ANYWHERE, EVER ────────────────────────────────────────
 * This file's rule is absolute and month-and-copy-test enforces it literally: `new Date(` must not
 * appear here at all. That is deliberately stronger than "no Date built from a match string" —
 * an absolute rule needs no judgement from the next person to edit this file, and the judgement is
 * exactly what goes wrong at 7pm on a Friday.
 *
 * So the day arithmetic is Howard Hinnant's days-from-civil, which is pure integer maths on a
 * proleptic Gregorian calendar. It has no timezone to shift by because it has no instant in it. */
function daysFromCivil(y: number, m: number, d: number): number {
  const yy = y - (m <= 2 ? 1 : 0);
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;                                  // [0, 399]
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}
function civilFromDays(z: number): [number, number, number] {
  const zz = z + 719468;
  const era = Math.floor(zz / 146097);
  const doe = zz - era * 146097;                               // [0, 146096]
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return [y + (m <= 2 ? 1 : 0), m, d];
}

/** Wall-clock string → minutes on a plain calendar. NaN when it does not parse. */
function wallMinutes(s: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s);
  if (!m) return NaN;
  return daysFromCivil(Number(m[1]), Number(m[2]), Number(m[3])) * 1440 + Number(m[4]) * 60 + Number(m[5]);
}

/** Minutes → "YYYY-MM-DDTHH:MM", with `suffix` (":00.000Z") carried over from the source string. */
function fromWallMinutes(mins: number, suffix: string): string {
  const days = Math.floor(mins / 1440);
  const rem = mins - days * 1440;
  const [y, mo, d] = civilFromDays(days);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${String(y).padStart(4, "0")}-${p(mo)}-${p(d)}T${p(Math.floor(rem / 60))}:${p(rem % 60)}${suffix}`;
}

/* ── endDate IS NEVER RETARGETED. IT IS SHIFTED. ───────────────────────────────────────────────
 * This is the one place a bug here would be silent, because both failures render as a perfectly
 * normal-looking card in the grid:
 *
 *   a fixture starting 11:30 PM and ending 1:00 AM has its endDate on the FOLLOWING day — pinning
 *     the end to the picked date collapses it and produces a match that ends before it starts;
 *   moving 8:00 PM to 11:30 PM pushes an endDate ACROSS MIDNIGHT that was not there before —
 *     only a delta reaches the next day.
 *
 * So the end moves by exactly the minutes the start moved, and the match keeps its length. */
export function retargetPair(
  startDate: string, endDate: string, targetIso: string, hhmm?: string,
): { startDate: string; endDate: string } {
  const newStart = retargetStart(startDate, targetIso, hhmm);
  const a = wallMinutes(startDate), b = wallMinutes(newStart), e = wallMinutes(endDate);
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(e)) {
    // AN UNPARSEABLE PAIR IS LEFT ALONE rather than guessed at — a copy with an invented end is
    // worse than one the operator can see is wrong.
    return { startDate: newStart, endDate };
  }
  return { startDate: newStart, endDate: fromWallMinutes(e + (b - a), endDate.slice(16)) };
}

/** How long the fixture runs, in whole minutes. Used to state "90 min, unchanged" on the preview. */
export function durationMinutes(startDate: string, endDate: string): number | null {
  const a = wallMinutes(startDate), b = wallMinutes(endDate);
  return Number.isFinite(a) && Number.isFinite(b) ? b - a : null;
}

export type SourceMatch = Record<string, unknown> & {
  id?: unknown;
  teams?: unknown[];
  field?: { title?: unknown } | null;
  startDate?: unknown;
};

/**
 * Build the create body for a copy of `src`.
 *
 * ONLY KEYS THE SOURCE ACTUALLY HAS are sent. `if (k in src)` rather than `src[k] ?? null`:
 * the create route distinguishes an absent optional from an explicit null, and sending null for
 * something the source never carried is inventing a value.
 */
export function buildCopyBody(src: SourceMatch, target?: CopyTarget): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of COPY_FIELDS) {
    if (k === "teamNumbers") continue;          // derived below, never read off the source
    if (k in src && src[k] !== undefined) out[k] = src[k];
  }
  /* RETARGETED, OR BYTE FOR BYTE. With no target this is the copy it has always built — the same
   * day, the same time, the same strings. With one, the start moves to the picked date and time
   * and the end moves BY THE SAME DELTA. See retargetPair. */
  if (target && typeof src.startDate === "string" && typeof src.endDate === "string") {
    const pair = retargetPair(src.startDate, src.endDate, target.iso, target.hhmm);
    out.startDate = pair.startDate;
    out.endDate = pair.endDate;
  }
  /* THE TEAM COUNT. Not a field on the match — the length of its teams array. 2 is the floor
   * because the API rejects a create without it and every match has at least two sides. */
  out.teamNumbers = Array.isArray(src.teams) && src.teams.length > 0 ? src.teams.length : 2;
  return out;
}

/** Fields present on the source that the create route will NOT take — reported, not silently cut. */
export function droppedByCopy(src: SourceMatch): string[] {
  const allowed = new Set<string>([...COPY_FIELDS]);
  return Object.keys(src).filter((k) => !allowed.has(k)).sort();
}

/* ── THE CONFIRM LINE ──────────────────────────────────────────────────────────────────────────
 * One line: the match, its field, its date and its time. No form and nothing to fill in — the
 * copy is identical by definition, so a form would only be somewhere to introduce a difference.
 *
 * THE DATE AND TIME ARE READ OFF THE STRING, not formatted through a Date. Same reason as above:
 * the string is wall clock and a Date would shift it. "2026-09-04T19:30:00.000Z" reads as
 * "Sep 4, 7:30 PM" because that is what it says at the pitch. */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function wallClockLabel(startDate: unknown): string {
  const s = typeof startDate === "string" ? startDate : "";
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s);
  if (!m) return "date unknown";
  const [, , mo, d, hh, mi] = m;
  const h = Number(hh);
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${MONTHS[Number(mo) - 1] ?? "?"} ${Number(d)}, ${h12}:${mi} ${ampm}`;
}

export function copyConfirmLine(src: SourceMatch): string {
  const name = typeof src.name === "string" && src.name.trim() ? src.name : `match ${String(src.id ?? "?")}`;
  const field = typeof src.field?.title === "string" && src.field.title.trim() ? src.field.title.trim() : "its field";
  return `Copy “${name}” at ${field}, ${wallClockLabel(src.startDate)}? The copy is created live and identical — you can change it in the editor that opens.`;
}

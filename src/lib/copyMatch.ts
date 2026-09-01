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
export function buildCopyBody(src: SourceMatch): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of COPY_FIELDS) {
    if (k === "teamNumbers") continue;          // derived below, never read off the source
    if (k in src && src[k] !== undefined) out[k] = src[k];
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

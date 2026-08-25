// NOTES — the shared shape behind Slate Review's note list, and now Match Promotion's comments.
//
// LIFTED, NOT COPIED. All of this was inside SlateReviewView.tsx as local consts and an inline
// block. It moved here so a second page can use the SAME list rather than growing a second one:
// two comment systems is two places for the author, the week tag or the delete to be wrong.
//
// THIS FILE IS A PURE MOVE. Every function below is byte-for-byte what Slate Review already ran,
// and Slate Review now imports them back. Nothing about its behaviour changes, which is why the
// move is its own commit and verify-slate-notes runs against it untouched.

/** One row of `slate_notes` (migration 0119), as the route hands it back. */
export type SlateNote = {
  id: string;
  city: string;
  kind: "proposal" | "note";
  raw: string;
  day: string | null;
  timeTxt: string | null;
  timeMin: number | null;
  fieldTxt: string | null;
  weekStart: string;
  createdBy: string;
  createdAt: string;
};

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Aug 10". Shared by the note's week chip and Slate Review's demand chart — one definition, so
 *  the two cannot start printing a date differently. */
export const fmtWk = (d: Date): string => `${MON[d.getMonth()]} ${d.getDate()}`;

/** weekKey "YYYY-MM-DD" (a Monday) → a LOCAL date. These are calendar dates with no zone; parsing
 *  one through `new Date(string)` would read it as UTC and shift it a day in a western timezone. */
export function wkKeyToDate(key: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(key);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** The week chip's text: "week of Aug 10", falling back to the raw key if it will not parse. */
export function weekTag(weekStart: string): string {
  const d = wkKeyToDate(weekStart);
  return `week of ${d ? fmtWk(d) : weekStart}`;
}

/** "who added it" — the local part of the email is enough on a shared screen. The author is never
 *  typed: the route takes it from the signed-in session, so this only ever shortens it. */
export const shortWho = (email: string): string => (email || "").split("@")[0] || email;

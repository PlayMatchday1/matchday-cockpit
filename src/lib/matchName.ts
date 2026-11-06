/* MATCH NAMES: TRIMMED ON EVERY WRITE, COMPARED LOOSELY ON CANCEL (Ryan, 2026-11-06).
 *
 * WHAT HAPPENED. The Atlanta One Touch fixtures were saved as " One Touch" (leading space) and Copy
 * match carried the name verbatim onto fifteen dates. The cancel route TRIMMED the confirmation it
 * was sent and then compared it with === against the live name, so every cancel of those matches
 * failed with "The typed name doesn't match" — on a name nobody typed (the client sends the preview's
 * own name back). A whitespace-only difference is never a different match.
 *
 * THE RULE. A name is trimmed before it goes on the wire — create (which is also Copy match), the
 * edit PUT on both environments — so a new " One Touch" cannot be saved. The cancel check ignores
 * surrounding whitespace and case: its job is to catch a match RENAMED between preview and press,
 * and "One Touch" vs "one touch" is not that. Interior spacing still counts: "One  Touch" is not
 * "One Touch". */

/** The name as it should be stored: surrounding whitespace removed. Non-strings become "". */
export const trimMatchName = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v)).trim();

/** Same match name for the cancel confirmation: trimmed and case-insensitive, interior spacing kept. */
export const sameMatchName = (a: unknown, b: unknown): boolean =>
  trimMatchName(a).toLowerCase() === trimMatchName(b).toLowerCase();

/** In place: if the object carries a string `name`, trim it. Returns the same object. */
export function trimNameIn<T extends Record<string, unknown>>(o: T): T {
  if (typeof o.name === "string") (o as Record<string, unknown>).name = o.name.trim();
  return o;
}

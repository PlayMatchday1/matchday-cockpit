/* WHAT TO SHOW A PERSON WHEN SOMETHING FAILED.
 *
 * `e instanceof Error ? e.message : String(e)` is in this codebase 218 times, and for a Supabase
 * failure it prints **[object Object]**. A PostgrestError is a plain object — `{message, code,
 * details, hint}`, no prototype — so `instanceof Error` is false and `String({})` is the literal
 * text "[object Object]".
 *
 * That is not hypothetical. Deonna Garcia filled in Add venue for Wheatley Heights Sports Complex,
 * pressed Save field, and read "[object Object]". The real error, reproduced with her own account
 * on 2026-09-11, was:
 *
 *     {"code":"23502","message":"null value in column \"billing_type\" of relation
 *       \"fin_venues\" violates not-null constraint"}
 *
 * — which names the cause exactly, and which she was never shown. (An admin gets the identical
 * error: the Add-venue payload omits a NOT NULL column, so that drawer cannot succeed for anybody.
 * Reported, not fixed here: what a new venue's billing_type should be is a money decision.)
 *
 * THE CODE IS PART OF THE MESSAGE. `42501` is "you are not allowed to do this" and `23502` is
 * "something is broken"; without the code nobody can tell those apart, and the two need different
 * actions from the reader. So a refusal gets a sentence in plain words, and everything else keeps
 * the database's own message with its code in brackets — the message names the column, and the
 * column is usually the whole answer.
 */

/** A PostgrestError, or anything else carrying a message — duck-typed, never instanceof. */
type MessageLike = { message?: unknown; code?: unknown; details?: unknown; hint?: unknown };

const isObj = (e: unknown): e is MessageLike => typeof e === "object" && e !== null;

/* THE CODES WORTH A SENTENCE. Every one of these is a thing the reader can act on, and the
 * database's own wording for them is either jargon ("permission denied for table fin_venues") or
 * absent. Nothing else is translated: inventing plain English for a code nobody has seen would be
 * guessing at what went wrong. */
const SAID_PLAINLY: Record<string, string> = {
  // insufficient_privilege — RLS or a missing grant refused the write.
  "42501": "Your account is not allowed to do this. Ask an admin.",
  // PostgREST's own auth codes: the session is gone, and reloading is the fix.
  PGRST301: "Your session has expired. Reload the page and sign in again.",
  PGRST302: "Your session has expired. Reload the page and sign in again.",
};

export function errorText(e: unknown, fallback = "Something went wrong."): string {
  if (e == null) return fallback;
  // A real Error (fetch failures, thrown Error objects) already reads correctly.
  if (e instanceof Error) return e.message || fallback;
  if (typeof e === "string") return e.trim() || fallback;
  if (isObj(e)) {
    const code = typeof e.code === "string" || typeof e.code === "number" ? String(e.code) : null;
    const said = code ? SAID_PLAINLY[code] : undefined;
    if (said) return said;
    const msg = typeof e.message === "string" && e.message.trim() ? e.message.trim() : null;
    if (msg) return code ? `${msg} (${code})` : msg;
    /* NO MESSAGE AT ALL. Print the shape rather than "[object Object]" — the keys are what tells
     * the next person where to look, and a code on its own is still actionable. */
    const keys = Object.keys(e);
    if (code) return `${fallback} (${code})`;
    return keys.length ? `${fallback} (${keys.join(", ")})` : fallback;
  }
  return fallback;
}

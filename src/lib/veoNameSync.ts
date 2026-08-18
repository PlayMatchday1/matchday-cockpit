// 🎥 IN THE MATCH NAME — the minimal edit to send, and nothing else.
//
// The VEO flag (veo_intent.enabled) is the source of truth. The camera emoji in the MatchDay match
// name is DERIVED from it, and it is the half that players see in the live app.
//
// WHY THIS IS NOT stripCameraEmoji (veo.ts:670). That one answers a DISPLAY question — "show me
// this name without any camera decoration" — so it removes EVERY camera-family glyph, globally,
// and re-normalises whitespace. This module answers a WRITE question: "what is the smallest change
// that makes the name agree with the flag, if any?" A write must touch one glyph, must be able to
// say "nothing to do", and must never rewrite parts of a name nobody asked it to. Same subject,
// different questions; keeping them apart is deliberate.
//
// SCOPE IS 🎥 U+1F3A5 AND ONLY IT. The display helper matches a family of eight camera glyphs
// because it is guessing at intent in names people typed by hand. This one is writing, so it acts
// only on the exact character it also writes. Widening it would let a toggle delete a 📷 somebody
// chose on purpose.
//
// WHAT PRODUCTION ACTUALLY LOOKS LIKE (9,627 live matches, read 2026-08-18):
//   4,084 names begin with an emoji — only 866 of those are the camera
//   3,218 begin with a DIFFERENT emoji: 🔥 ⚡️ 💥 ❤️‍🔥 🎩 🏆 ☄️ 👑 🍀 🧦
//     166 carry the camera at index > 0, after a decorative one: "🔥🎥 Monday - NEMP - M1"
//     171 leading cameras have NO space after: "🎥The Hattrick (Leander)"
// Every rule below was written against those shapes. A rule anchored at index 0 would have
// double-marked all 166.

/** The one glyph this module reads and writes. */
export const CAMERA = "\u{1F3A5}";

export type NameEdit =
  | { change: false; reason: "already-marked" | "not-marked" }
  | { change: true; next: string };

/**
 * ON — never two cameras, absolutely.
 *
 * The check is "anywhere in the string", NOT "at index 0". That is the whole point: 166 live
 * matches carry the camera mid-string, and an index-0 test cannot see them, so it would prefix a
 * second one and ship "🎥 🔥🎥 Monday - NEMP - M1" to every player in that match. Of the two rules
 * that could govern this, never-two is the one whose failure is visible in the app.
 */
export function nameOn(name: string | null | undefined): NameEdit {
  // A MISSING NAME IS NOT AN EMPTY ONE. rawName is newly carried on the schedule row; a cached or
  // fixture payload without it must produce "no change", never a PUT that blanks a live match name.
  if (typeof name !== "string" || name === "") return { change: false, reason: "already-marked" };
  if (name.includes(CAMERA)) return { change: false, reason: "already-marked" };
  return { change: true, next: `${CAMERA} ${name}` };
}

/**
 * OFF — remove the FIRST camera, wherever it is, exactly once.
 *
 *   "🔥🎥 Monday - NEMP - M1"  → "🔥 Monday - NEMP - M1"
 *   "🎥The Hattrick (Leander)" → "The Hattrick (Leander)"
 *   "🎥 Saturday - SJD"        → "Saturday - SJD"
 *
 * ONE OCCURRENCE, NO LOOP. A name carrying two cameras loses one per toggle-off. Looping would
 * turn a single toggle into a cleanup job over a name nobody asked us to normalise.
 *
 * The collapse/trim is scoped to the gap the removal itself opened — it is repair, not
 * normalisation. Double spaces elsewhere in the name are left alone.
 */
export function nameOff(name: string | null | undefined): NameEdit {
  if (typeof name !== "string" || name === "") return { change: false, reason: "not-marked" };
  const at = name.indexOf(CAMERA);
  if (at < 0) return { change: false, reason: "not-marked" };
  const before = name.slice(0, at);
  const after = name.slice(at + CAMERA.length);
  const head = before.replace(/\s+$/, "");
  const tail = after.replace(/^\s+/, "");
  // Rejoin with ONE space only if there was whitespace at the seam to begin with, and there is
  // something on both sides of it. "🔥🎥Monday" had no space and does not gain one.
  const spanned = /\s$/.test(before) || /^\s/.test(after);
  const joiner = head && tail && spanned ? " " : "";
  return { change: true, next: (head + joiner + tail).trim() };
}

/**
 * The edit implied by a flag value — the single entry point the write path calls.
 * `{change:false}` means SEND NO REQUEST. It is not "send the same name again": an unnecessary
 * PUT is a real write to a live match, and there is no Idempotency-Key to make it safe.
 */
export function nameForVeo(name: string | null | undefined, enabled: boolean): NameEdit {
  return enabled ? nameOn(name) : nameOff(name);
}

// THERE IS NO DERIVED "UNSYNCED" PREDICATE HERE, DELIBERATELY.
//
// isVeoUnsynced(name, enabled) used to live here and the chip rendered from it. It could not tell
// a write that JUST FAILED from a row that predates this feature, so it flagged 38 historical
// matches nobody had touched. Worse, /api/veo reads the mdapi_matches MIRROR, which lags a write —
// 6 of 6 landed writes were still absent from it an hour later — so it also flagged every
// SUCCESSFUL write and invited a Retry that re-sent the identical name. Three of those duplicates
// are in change_log as `notapplied`.
//
// "Did the write I just made land?" is a fact about a session, not about a row. It lives in
// component state in VeoMasterSchedule and dies with the page, which is the correct lifetime.

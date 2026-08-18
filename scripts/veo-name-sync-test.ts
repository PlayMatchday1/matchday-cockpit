// THE 🎥 NAME TRANSFORM — every rule, against REAL production name shapes.
//
// This writes to a live match name that every player in that match can see, so the transform is
// pinned here as pure functions before any of it reaches a request. The fixtures are not invented:
// they are the shapes actually present in the 9,627 live matches read on 2026-08-18, and each one
// exists because it breaks a rule that looked obviously correct in the abstract.
//
//   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/veo-name-sync-test.ts

import { nameOn, nameOff, nameForVeo, isVeoUnsynced, unsyncedReason, CAMERA, type NameEdit } from "../src/lib/veoNameSync";

// NEVER CAST AN EDIT TO {change:true}. A regression that returns "no change" would then throw on
// `.next` and the suite would die with a stack trace instead of naming the assertion that broke —
// which is exactly what happened the first time these mutations were run.
const nextOf = (e: NameEdit): string => (e.change ? e.next : "(NO CHANGE)");

let PASS = 0, FAIL = 0;
const ok = (n: string) => { PASS++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { FAIL++; console.log(`  XX  ${n} — ${d}`); };
const is = (n: string, got: unknown, want: unknown) =>
  (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

const C = CAMERA;
// ── REAL PRODUCTION SHAPES ────────────────────────────────────────────────────────────────────
const MID     = "\u{1F525}\u{1F3A5} Monday - NEMP - M1";      // 166 live matches look like this
const MID2    = "\u{1F3A9}\u{1F3A5} Premier Match (928)";
const NOSPACE = "\u{1F3A5}The Hattrick (Leander)";            // 171 leading cameras have no space
const LEAD    = "\u{1F3A5} Saturday - SJD";
const OTHER   = "⚡️ Saturday - SJD - M2";           // 3,218 lead with a NON-camera emoji
const LONGEST = "\u{1F3C6}\u{1F3A5} (8:15 PM Kick Off! \u{1F6A8}) Monday - Westlake - Tournament - Field 3"; // 65 cp
const PLAIN   = "Saturday - SJD";

console.log("ON — never two cameras, checked ANYWHERE not at index 0:");
is("plain name gains the prefix", nameOn(PLAIN), { change: true, next: `${C} ${PLAIN}` });
is("camera at index 0 → NO REQUEST", nameOn(LEAD), { change: false, reason: "already-marked" });
is("camera at index > 0 → NO REQUEST (the never-two case)", nameOn(MID), { change: false, reason: "already-marked" });
is("…the other real mid-string shape too", nameOn(MID2), { change: false, reason: "already-marked" });
is("no-space leading camera → NO REQUEST", nameOn(NOSPACE), { change: false, reason: "already-marked" });
is("the 65-code-point name already carries one → NO REQUEST", nameOn(LONGEST), { change: false, reason: "already-marked" });
is("a NON-camera leading emoji is not mistaken for one", nameOn(OTHER), { change: true, next: `${C} ${OTHER}` });
// IDEMPOTENT: the output of ON, fed back through ON, is not a change.
is("ON twice yields exactly one camera", nameOn(nextOf(nameOn(PLAIN))), { change: false, reason: "already-marked" });
is("  …and the once-prefixed name holds exactly one", [...nextOf(nameOn(PLAIN))].filter((c) => c === C).length, 1);

console.log("\nOFF — the FIRST camera, wherever it is, exactly once:");
is("index 0, with a space → no leading space left", nameOff(LEAD), { change: true, next: "Saturday - SJD" });
is("index 0, no space", nameOff(NOSPACE), { change: true, next: "The Hattrick (Leander)" });
is("index > 0 → no double space left", nameOff(MID), { change: true, next: "\u{1F525} Monday - NEMP - M1" });
is("index > 0, the other shape", nameOff(MID2), { change: true, next: "\u{1F3A9} Premier Match (928)" });
is("a space on BOTH sides collapses to one", nameOff(`\u{1F525} ${C} Monday`), { change: true, next: "\u{1F525} Monday" });
is("no space on either side does NOT invent one", nameOff(`\u{1F525}${C}Monday`), { change: true, next: "\u{1F525}Monday" });
is("no camera → NO REQUEST", nameOff(PLAIN), { change: false, reason: "not-marked" });
is("a non-camera emoji is left alone → NO REQUEST", nameOff(OTHER), { change: false, reason: "not-marked" });
// TWO CAMERAS: one per toggle-off, never a loop.
{
  const two = `${C} a ${C} b`;
  const once = nextOf(nameOff(two));
  is("two cameras → exactly ONE removed", once, `a ${C} b`);
  is("  …one camera still present after a single off", [...once].filter((c) => c === C).length, 1);
  const twice = nextOf(nameOff(once));
  is("  …a SECOND off removes the other (one per toggle, no loop)", [...twice].filter((c) => c === C).length, 0);
}
is("the 65-cp name loses only its camera", nameOff(LONGEST),
   { change: true, next: "\u{1F3C6} (8:15 PM Kick Off! \u{1F6A8}) Monday - Westlake - Tournament - Field 3" });

console.log("\nthe accepted consequence — off-then-on moves a mid-string camera to the front:");
{
  const off = nextOf(nameOff(MID));
  const on = nextOf(nameOn(off));
  is("\"🔥🎥 X\" → \"🔥 X\" → \"🎥 🔥 X\"", on, `${C} \u{1F525} Monday - NEMP - M1`);
  is("  …and it converged on exactly one camera", [...on].filter((c) => c === C).length, 1);
  // Stable from here: the standard form round-trips without moving again.
  is("  …the standard form is now stable", nextOf(nameOn(nextOf(nameOff(on)))), on);
}

console.log("\nnameForVeo dispatches on the flag:");
is("enabled true takes the ON branch", nameForVeo(PLAIN, true), nameOn(PLAIN));
is("enabled false takes the OFF branch", nameForVeo(LEAD, false), nameOff(LEAD));

console.log("\na MISSING name never produces a write (rawName is newly carried):");
is("undefined, on", nameForVeo(undefined, true), { change: false, reason: "already-marked" });
is("undefined, off", nameForVeo(undefined, false), { change: false, reason: "not-marked" });
is("empty string, on", nameForVeo("", true), { change: false, reason: "already-marked" });
is("null is not treated as unsynced", isVeoUnsynced(null, true), false);

console.log("\nthe DERIVED unsynced state:");
is("flag on + no camera = unsynced", isVeoUnsynced(PLAIN, true), true);
is("flag off + a camera = unsynced", isVeoUnsynced(LEAD, false), true);
is("flag on + camera at index 0 = synced", isVeoUnsynced(LEAD, true), false);
is("flag on + camera at index > 0 = SYNCED (today's 166)", isVeoUnsynced(MID, true), false);
is("flag off + no camera = synced", isVeoUnsynced(PLAIN, false), false);
is("the reason names the missing direction", unsyncedReason(PLAIN, true), "name not updated — the 🎥 was not added");
is("the reason names the lingering direction", unsyncedReason(LEAD, false), "name not updated — the 🎥 is still there");
is("synced has no reason", unsyncedReason(MID, true), null);

// A WRITE THIS MODULE PRODUCES MUST BE THE SMALLEST ONE. Every {change:true} must actually differ
// from its input — a "change" equal to the input would be a live write that alters nothing.
console.log("\nno edit is ever a no-op write:");
{
  const all = [PLAIN, LEAD, MID, MID2, NOSPACE, OTHER, LONGEST, `${C} a ${C} b`];
  let checked = 0, noop = 0;
  for (const n of all) for (const en of [true, false]) {
    const e = nameForVeo(n, en);
    if (e.change) { checked++; if (e.next === n) noop++; }
  }
  is(`  every produced edit differs from its input (${checked} edits examined)`, noop, 0);
  // POSITIVE CONTROL: the loop actually examined edits, so the zero above means something.
  is("  control — the scan saw real edits, so that 0 is not an empty loop", checked > 0, true);
}

console.log(`\n${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);

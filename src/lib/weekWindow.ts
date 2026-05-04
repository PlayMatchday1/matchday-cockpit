// Shared week-window math for cockpit views that anchor on
// "this week" / "the most recent fully-completed week".
//
// Two consumers today:
//   - cancelPatterns.ts (Cancel Patterns Mon-Sun grid)
//   - matchPnL.ts (Match P&L week selector)
// If you find yourself rewriting Monday-of-week math somewhere
// new, please add the helper here instead.
//
// All Date math uses local timezone (no UTC offsets) — operationally
// the cockpit's "this week" is the operator's wall-clock week.

// Most recent Monday on or before `d`. Mon=Mon, Sun→prev Mon.
export function getMonday(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = x.getDay();
  // dow=0 (Sun) → -6 (back to last Mon). dow=1 (Mon) → 0.
  // dow=2..6 → 1-dow (back to this week's Mon).
  const offset = dow === 0 ? -6 : 1 - dow;
  x.setDate(x.getDate() + offset);
  return x;
}

// Anchor for "the most recent fully-completed week ending Sunday".
// On Mon-Sat the most-recent-completed week ended last Sunday, so
// the anchor Monday is thisMonday - 7. On Sunday we use thisMonday
// itself — by Sunday evening (when ops typically reviews the week)
// the just-finishing week is effectively complete, and pointing at
// the prior week instead would be unintuitive. Single intentional
// special case.
export function mostRecentCompletedWeekMonday(now: Date = new Date()): Date {
  const thisMonday = getMonday(now);
  const isSunday = now.getDay() === 0;
  if (isSunday) return thisMonday;
  return new Date(
    thisMonday.getFullYear(),
    thisMonday.getMonth(),
    thisMonday.getDate() - 7,
  );
}

// Sunday end-of-day for the week starting at the given Monday.
// Returns 23:59:59.999 so timestamp comparisons cover the full day.
export function sundayEndOf(monday: Date): Date {
  return new Date(
    monday.getFullYear(),
    monday.getMonth(),
    monday.getDate() + 6,
    23,
    59,
    59,
    999,
  );
}

// Inclusive Sunday for the week starting at the given Monday (no time
// component). Useful for label formatting.
export function sundayOf(monday: Date): Date {
  return new Date(
    monday.getFullYear(),
    monday.getMonth(),
    monday.getDate() + 6,
  );
}

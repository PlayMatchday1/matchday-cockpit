// FIXTURES FOR THE TWO LAUNCH-PLAN SUITES.
//
// ══ NOTHING IS PINNED TO A DATE ══════════════════════════════════════════════════════════════
// verify-pace-readout hardcoded "days the month has not reached" and went red on the 25th. Every
// launch date here is an OFFSET FROM TODAY, so a suite run in March asserts the same thing a suite
// run in November does. The offsets are chosen to put one field in each of the three counter
// states plus one past week 20.
//
// ══ THE TEMPLATE IS READ OUT OF THE APP, NOT RETYPED ═════════════════════════════════════════
// A second copy of the 24 tasks in a fixture is a copy that drifts, and then the suite is checking
// the fixture rather than the playbook. tsx evaluates the real module.

import { execFileSync } from "node:child_process";

/** The 24 playbook tasks, straight out of src/lib/launchPlan.ts. */
export function readTemplate() {
  const out = execFileSync(
    "npx",
    [
      "tsx",
      "-e",
      "import { TEMPLATE } from './src/lib/launchPlan.ts'; console.log(JSON.stringify(TEMPLATE));",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const line = out.trim().split("\n").pop();
  return JSON.parse(line);
}

const DAY = 86400000;

/** YYYY-MM-DD for local midnight `n` days from today — the same wall-clock model the app uses. */
export function isoOffset(n) {
  const t = new Date();
  const d = new Date(t.getFullYear(), t.getMonth(), t.getDate() + n);
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** The app's own week arithmetic, repeated here so the suite can predict what it should see. */
export function weekOfOffset(daysToLaunch) {
  return Math.floor((28 - daysToLaunch) / 7) + 1;
}

/* ── THE SEVEN FIELDS ──────────────────────────────────────────────────────────────────────────
 * days = signed days to launch.
 *   +2   nearest, so it must sort to the top of STILL TO LAUNCH
 *   +27  week 1 — nothing can be overdue, and the page must not invent an alarm
 *   +13 / +69  the rest of the still-to-launch group
 *   -9   week 6 — inside the launch window, so the hero reads "2 of 4" and never "-9"
 *   -36  week 10 — launched, counting up
 *   -150 week 26 — past week 20, so it leaves the index while still being counted as finished */
export const FIELDS = [
  { id: 900101, name: "Crossbar Rowlett", city: "Dallas", days: 27, coordIdx: 0 },
  { id: 900102, name: "Stony Point", city: "Austin", days: 13, coordIdx: 0 },
  { id: 900103, name: "Hala Pilkarska 2", city: "Warsaw", days: 69, coordIdx: 1 },
  { id: 900104, name: "Soccer Central Field 5", city: "San Antonio", days: 2, coordIdx: 1 },
  { id: 900105, name: "Parmer Fields 3", city: "Austin", days: -9, coordIdx: 2 },
  { id: 900106, name: "NEMP Field 13", city: "Austin", days: -36, coordIdx: 2 },
  { id: 900107, name: "PRUMC", city: "Atlanta", days: -150, coordIdx: 0 },
];

export const venueRows = () =>
  FIELDS.map((f) => ({
    id: f.id,
    venue_name: f.name,
    city: f.city,
    launch_date: isoOffset(f.days),
    billing_type: "per_match",
    is_active: true,
  }));

export const cardRows = (owners) =>
  FIELDS.map((f, i) => ({
    id: `00000000-0000-4000-8000-${String(900000 + i).padStart(12, "0")}`,
    board_type: "field_pipeline",
    title: f.name,
    stage: "confirmed",
    owner_user_id: owners[f.coordIdx % Math.max(1, owners.length)] ?? null,
    sort_order: i + 1,
    data: { city: f.city },
    venue_id: f.id,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }));

/* ── TASK ROWS ─────────────────────────────────────────────────────────────────────────────────
 * Built from the real template, then marked done/na per field so the index has something to count.
 *
 * `done` TICKS THE LAST N IN PLAYBOOK ORDER, NOT THE FIRST. The playbook is ordered roughly by
 * deadline, so ticking from the front would leave only late-deadline tasks outstanding and NOTHING
 * WOULD EVER BE OVERDUE — the suite would then be asserting zero against a page that also prints
 * zero when it is broken. Ticking from the back leaves early deadlines open, which is what overdue
 * is made of.
 *
 * OVERDUE IS NEVER SET DIRECTLY — it is a consequence of the field's week and each task's window,
 * so the suite computes what it expects rather than asserting a number it planted. */
export function taskRows(template, spec) {
  let id = 5_000_000;
  const rows = [];
  for (const f of FIELDS) {
    const s = spec[f.id] ?? {};
    const n = s.done ?? 0;
    const done = new Set(template.slice(template.length - n).map((t) => t.key));
    const na = new Set(s.na ?? []);
    template.forEach((t, i) => {
      rows.push({
        id: id++,
        venue_id: f.id,
        template_key: t.key,
        title: t.title,
        scope: t.scope,
        department: t.department,
        week_start: t.w1,
        week_end: t.w2,
        sort_order: i + 1,
        done: done.has(t.key) && !na.has(t.key),
        na: na.has(t.key),
        owner_user_id: null,
      });
    });
  }
  return rows;
}

/** What the page should show for one field, computed the way the app computes it. */
export function expected(field, tasks) {
  const week = weekOfOffset(field.days);
  const live = tasks.filter((t) => t.venue_id === field.id && !t.na);
  return {
    week,
    live: week <= 20,
    done: live.filter((t) => t.done).length,
    total: live.length,
    na: tasks.filter((t) => t.venue_id === field.id && t.na).length,
    over: live.filter((t) => !t.done && week > t.week_end).length,
  };
}

/* The done/N/A marks per field. Chosen so that at least one field is CLEAN and at least one
 * carries overdue work, which is what makes the "a card with overdue work looks different" control
 * mean something. */
export const SPEC = {
  900101: { done: 5 },                                       // week 1 - nothing CAN be late
  900102: { done: 14, na: ["ops-create-partner"] },           // 23 counted, 1 N/A
  900103: { done: 2 },                                       // the plan has not opened yet
  900104: { done: 24 },                                      // clean, everything done
  900105: { done: 21 },                                      // inside the launch window
  900106: { done: 19, na: ["crm-klaviyo", "crm-wa-group"] },  // 22 counted, 2 N/A
  900107: { done: 24 },                                      // past week 20, off the page
};

export { DAY };

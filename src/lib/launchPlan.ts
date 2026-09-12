// THE FIELD LAUNCH PLAYBOOK, AND THE ONE COUNTER BOTH PAGES READ.
//
// ══ WHAT IS HERE AND WHY IT IS IN ONE FILE ═══════════════════════════════════════════════════
// /growth/launch (the index) and /growth/launch/[venueId] (one field's plan) both have to answer
// "how far is this field from opening". If each computed it, they would disagree by a day the
// first time one of them rounded differently — and the index card and the plan hero sit two clicks
// apart, so the disagreement would be visible. counterFor() is that answer, once.
//
// ══ THE TEMPLATE IS A COPY SOURCE, NEVER A LIVE RECORD ═══════════════════════════════════════
// A field's plan is 24 rows in field_launch_tasks, copied from TEMPLATE at bind time. Editing one
// field's plan writes those rows and nothing else: this array is frozen, and nothing in the app
// writes back to it. Adding a task "for every future field" would be a different control on a
// different screen and it does not exist.

/* ── THE 20 WEEKS, AND WHERE LAUNCH SITS IN THEM ───────────────────────────────────────────────
 * Week 5 is the launch week — the green header band in the G2M Playbook — so week 1 opens 28 days
 * before the date. That is the sheet's own anchoring, made arithmetic. */
export const PLAN_WEEKS = 20;
export const LAUNCH_WEEK = 5;
const DAY = 86400000;

/* ── DATES ARE PLAIN YYYY-MM-DD AND ARE PINNED TO LOCAL MIDNIGHT ───────────────────────────────
 * fin_venues.launch_date is a DATE column with no zone. `new Date("2026-10-09")` parses as UTC
 * midnight, which in America/Chicago is the evening of the 8th — every countdown would be a day
 * long for most of the year. Both sides of every subtraction here go through this, so the
 * arithmetic is wall-clock on both ends and a timezone cannot move the count.
 *
 * This is the same trap the match startDate rule in CLAUDE.md describes, in a different costume. */
export function localMidnight(iso: string): number | null {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d).getTime();
}
const midnightOf = (t: Date) => new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();

/** Day 1 of week 1 — 28 days before launch. */
export function planStart(launchIso: string): number | null {
  const l = localMidnight(launchIso);
  return l == null ? null : l - (LAUNCH_WEEK - 1) * 7 * DAY;
}

/** Signed days to launch. Positive before, 0 on the day, negative after. */
export function daysToLaunch(launchIso: string, today = new Date()): number | null {
  const l = localMidnight(launchIso);
  return l == null ? null : Math.round((l - midnightOf(today)) / DAY);
}

/** Which of the 20 weeks the plan is in. 1 on the first day, 5 on launch day, can exceed 20. */
export function weekOf(launchIso: string, today = new Date()): number | null {
  const s = planStart(launchIso);
  return s == null ? null : Math.floor((midnightOf(today) - s) / (7 * DAY)) + 1;
}

export type PlanPhase = "pre" | "launch" | "post";

/** A week's phase. The sheet's own three bands. */
export function phaseOfWeek(w: number): PlanPhase {
  return w <= 4 ? "pre" : w <= 8 ? "launch" : "post";
}

export const PHASES: { key: PlanPhase; title: string; w1: number; w2: number; sub: string }[] = [
  { key: "pre", title: "Build-up", w1: 1, w2: 4, sub: "the four weeks before" },
  { key: "launch", title: "Launch window", w1: 5, w2: 8, sub: "opening month" },
  { key: "post", title: "Sustain", w1: 9, w2: PLAN_WEEKS, sub: "keeping it filled" },
];

/* ── ONE HERO NUMBER THAT CHANGES WHAT IT ANSWERS ──────────────────────────────────────────────
 * Ryan asked for "a days till launch and launch and post launch counter type thing". That is one
 * counter in three states, not three counters.
 *
 * IT IS NEVER NEGATIVE. Inside the window it counts the launch week (1 of 4 on launch day itself,
 * never 0 — the week is week 5 and the fifth week is the first week of the window), and after the
 * window it counts up from the date. A "-14 days to launch" is what this exists to prevent. */
export type Counter = { n: number; label: string; phase: PlanPhase };

export function counterFor(launchIso: string, today = new Date()): Counter | null {
  const d = daysToLaunch(launchIso, today);
  const w = weekOf(launchIso, today);
  if (d == null || w == null) return null;
  if (d > 0) return { n: d, label: "DAYS TO LAUNCH", phase: "pre" };
  if (w <= 8) return { n: Math.max(1, w - 4), label: "LAUNCH WEEK OF 4", phase: "launch" };
  return { n: Math.abs(d), label: "DAYS SINCE LAUNCH", phase: "post" };
}

/** A plan is finished once week 20 is past: nothing left to chase, so it leaves the index. */
export function isLive(launchIso: string, today = new Date()): boolean {
  const w = weekOf(launchIso, today);
  return w != null && w <= PLAN_WEEKS;
}

/* ── SCOPE IS TEXT, NOT COLOUR, AND THAT IS A MEASURED CUT ─────────────────────────────────────
 * The sheet colours by scope, so the first build did too — six hues, then seven once Ops arrived.
 * Both fail the contrast validator under --pairs all, which is the right mode for chips in a list
 * where any two can end up side by side:
 *   seven:  #008300 vs #eb6834  ΔE 3.2 (protan)  — Ops and Paid Marketing are the same chip
 *   six+7:  #e87ba4 vs #eb6834  ΔE 12.9 (normal) — below the 15 floor, a hard fail
 * The validator's instruction on a fail is to CUT THE SERIES, not to generate more hues. The dot
 * was carrying nothing besides: every scope is spelled out next to it.
 *
 * DO NOT REINTRODUCE SCOPE COLOURS. Colour here is spent on state, which is the thing that needs
 * chasing. If you think seven hues pass --pairs all on this surface, run it and paste the report
 * before changing anything. */
export type ScopeKey = "ops" | "paid" | "crm" | "event" | "online" | "offline" | "exec";

export const SCOPES: Record<ScopeKey, string> = {
  ops: "Ops",
  paid: "Paid Marketing",
  crm: "CRM",
  event: "Launch Event",
  online: "Local · Online",
  offline: "Local · Offline",
  exec: "Field Launch Execution",
};

export const SCOPE_KEYS = Object.keys(SCOPES) as ScopeKey[];

/* ── THE DEPARTMENT COLUMN, AND THE ONLY THING IT CAN SEED ─────────────────────────────────────
 * The sheet's Department is a ROLE — "Marketing", "Launch Coordinator", "Launch Coordinator /
 * Marketing" — never a person, so it cannot name an owner. The one real mapping available is that
 * the launch coordinator IS the pipeline card's owner, which 25 of the 27 Confirmed cards carry.
 * So `coordinator: true` tasks are seeded to that person at bind time and everything else starts
 * unassigned, rather than inventing a name that would then look authoritative. */
export type TemplateTask = {
  /** Stable per-task identity, so re-seeding a venue is idempotent and never duplicates a row. */
  key: string;
  title: string;
  scope: ScopeKey;
  department: string;
  w1: number;
  w2: number;
  /** Seed this one to the bound card's owner — the launch coordinator. */
  coordinator: boolean;
};

/* ── THE 23 SHEET ROWS PLUS RYAN'S ─────────────────────────────────────────────────────────────
 * Read off the G2M Playbook (Drive id 1nky9N4Hbr…, modified 2026-08-26). TITLES, DEPARTMENTS,
 * SCOPES AND ORDER were checked against the live sheet and match.
 *
 * THE WEEK WINDOWS WERE NOT, AND CANNOT BE. The sheet's week columns are cell FILL, not values —
 * every export renders 20 empty cells per row — so w1/w2 here came off a screenshot and are the
 * one part of this table with no machine-readable source. They seed every future field, so a wrong
 * window is wrong forever: check them by eye against the sheet before trusting a date.
 *
 * THE 24TH IS RYAN'S, and it is the prerequisite the rest waits on: "one of the Ops tasks will be
 * create field partner in App". Nothing else in the plan can happen until the field exists in the
 * app, so it is week 1 and it is first. */
export const TEMPLATE: readonly TemplateTask[] = Object.freeze(
  (
    [
      ["ops-create-partner", "Create the field partner in the app", "ops", "Ops", 1, 2, false],
      ["paid-meta-setup", "Set up META Ads", "paid", "Marketing", 2, 2, false],
      ["paid-ads-active", "Ads Active (include the special event)", "paid", "Marketing", 3, 20, false],
      ["crm-wa-group", "Create WA group and share with the launch coordinator", "crm", "Marketing", 3, 3, false],
      ["crm-klaviyo", "Send campaigns via Klaviyo to registered users", "crm", "Marketing", 4, 8, false],
      ["crm-wa-players", "Add players to the WA group", "crm", "Marketing", 5, 8, false],
      ["crm-referral", "Share referral codes and free match codes", "crm", "Marketing", 5, 8, false],
      ["crm-starting-11", "Select the starting 11 / ambassador program", "crm", "Marketing", 7, 8, false],
      ["crm-player-db", "Talk with the field about any player database", "crm", "Launch Coordinator / Marketing", 1, 2, true],
      ["event-type", "Determine the launch type (tourney, giveaway, drinks, influencers)", "event", "Launch Coordinator / Marketing", 1, 2, true],
      ["event-influencers", "Search and secure influencers for the first games", "event", "Launch Coordinator / Marketing", 3, 8, true],
      ["online-research", "Research FB groups and other online platforms", "online", "Launch Coordinator", 1, 3, true],
      ["online-post", "Post in online platforms about matches and MM openings", "online", "Launch Coordinator", 4, 20, true],
      ["offline-stakeholders", "Research key stakeholders in the city", "offline", "Launch Coordinator", 1, 3, true],
      ["offline-flyers", "Print / receive MD flyers for key stakeholders", "offline", "Launch Coordinator", 1, 3, true],
      ["offline-bars", "Daily visits to bars and soccer stores near the field", "offline", "Launch Coordinator", 4, 20, true],
      ["offline-nearby", "Visit nearby fields to invite players", "offline", "Launch Coordinator", 4, 20, true],
      ["offline-play", "Participate in games at the new field", "offline", "Launch Coordinator", 4, 20, true],
      ["offline-wa-invite", "Invite people to the WA group (outside MD)", "offline", "Launch Coordinator", 4, 20, true],
      ["offline-events", "Research special soccer events in the city", "offline", "Launch Coordinator", 4, 20, true],
      ["exec-photographer", "Book a photographer for the first matches", "exec", "Launch Coordinator", 3, 4, true],
      ["exec-social", "Coordinate a social media partnership with the field", "exec", "Launch Coordinator", 3, 4, true],
      ["exec-action-shots", "Secure action shots of players during the first games", "exec", "Launch Coordinator", 5, 8, true],
      ["exec-content", "Create content to promote the launch online", "exec", "Launch Coordinator", 5, 8, true],
    ] as const
  ).map(([key, title, scope, department, w1, w2, coordinator]) =>
    Object.freeze({ key, title, scope, department, w1, w2, coordinator } as TemplateTask),
  ),
);

/* ── A TASK'S STATE ────────────────────────────────────────────────────────────────────────────
 * "over" is the only state that needs chasing, so it is the only one that gets a status hue with
 * any weight. N/A is out of the denominator, out of the overdue count and out of the timeline —
 * but still on the page, because the record of having deliberately skipped it is the thing that
 * deleting it would destroy. */
export type TaskState = "over" | "now" | "soon" | "done" | "na";

export type PlanTaskLike = { w1: number; w2: number; done: boolean; na: boolean };

export function stateOf(t: PlanTaskLike, weekNow: number): TaskState {
  if (t.na) return "na";
  if (t.done) return "done";
  if (weekNow > t.w2) return "over";
  if (weekNow >= t.w1) return "now";
  return "soon";
}

/** Overdue, then live, then not yet, then done, then skipped. The order the page is read in. */
export const STATE_RANK: Record<TaskState, number> = { over: 0, now: 1, soon: 2, done: 3, na: 4 };

export const STATE_LABEL: Record<TaskState, string> = {
  over: "OVERDUE",
  now: "DUE NOW",
  soon: "NOT YET",
  done: "DONE",
  na: "N/A",
};

/** Status is ICON + WORD, never colour alone. */
export const STATE_ICON: Record<TaskState, string> = {
  over: "!",
  now: "→",
  soon: "·",
  done: "✓",
  na: "—",
};

/** "1 Jul 2026" — and it is always read back beside a countdown, never shown as a bare date. */
export function fmtLaunchDate(iso: string): string {
  const t = localMidnight(iso);
  if (t == null) return iso;
  return new Date(t).toLocaleDateString("en-US", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** The switcher's one-line form: "2d to launch" / "36d since". */
export function shortCountdown(launchIso: string, today = new Date()): string {
  const d = daysToLaunch(launchIso, today);
  if (d == null) return "";
  return d >= 0 ? `${d}d to launch` : `${Math.abs(d)}d since`;
}

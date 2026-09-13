"use client";

// READING AND WRITING ONE FIELD'S LAUNCH PLAN (field_launch_tasks, migration 0173).
//
// Straight to Supabase from the client, as the kanban board and the goals pages do. RLS carries
// the gate — field_launch_tasks_rw reuses kanban_board_readable('field_pipeline') — so there is no
// server route to keep in step.

import { supabase } from "@/lib/supabase";
import { TEMPLATE, isLive, type ScopeKey } from "@/lib/launchPlan";

export type PlanTask = {
  id: number;
  venue_id: number;
  /** Null means somebody added this task for this field — the only kind that can be removed. */
  template_key: string | null;
  title: string;
  scope: ScopeKey;
  department: string | null;
  week_start: number;
  week_end: number;
  sort_order: number;
  done: boolean;
  na: boolean;
  owner_user_id: string | null;
};

/* ── THE TABLE MAY NOT BE THERE YET ────────────────────────────────────────────────────────────
 * Migrations land before the code that depends on them, but the code DEPLOYS first and 0173 is
 * applied by hand in the SQL Editor. Between those two moments PostgREST answers PGRST205 for
 * every read and write here. That must not take the Field Pipeline board down with it, so every
 * caller distinguishes "the table is missing" from "the query failed", and binding a card keeps
 * working either way — the plan seeds on first open instead. */
export function isMissingTable(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  return err.code === "PGRST205" || /could not find the table/i.test(err.message ?? "");
}

export const PLAN_TASK_COLUMNS =
  "id, venue_id, template_key, title, scope, department, week_start, week_end, sort_order, done, na, owner_user_id";

/** Every task row for a set of fields, in one query. The index needs all of them at once. */
export async function loadTasksForVenues(
  venueIds: number[],
): Promise<{ tasks: PlanTask[]; missingTable: boolean; error: string | null }> {
  if (venueIds.length === 0) return { tasks: [], missingTable: false, error: null };
  const { data, error } = await supabase
    .from("field_launch_tasks")
    .select(PLAN_TASK_COLUMNS)
    .in("venue_id", venueIds)
    .order("sort_order", { ascending: true })
    .order("id", { ascending: true });
  if (error) {
    if (isMissingTable(error)) return { tasks: [], missingTable: true, error: null };
    return { tasks: [], missingTable: false, error: error.message };
  }
  return { tasks: (data ?? []) as PlanTask[], missingTable: false, error: null };
}

/* ── SEEDING ───────────────────────────────────────────────────────────────────────────────────
 * A plan is a COPY of the playbook, so seeding is "insert the template keys this venue does not
 * have yet". Stated that way it is idempotent for free: running it twice, or in two tabs, inserts
 * nothing the second time, and the partial unique index on (venue_id, template_key) is the
 * backstop if both tabs read an empty plan at the same instant.
 *
 * IT IS ALSO A REPAIR. A venue bound before 0173 applied has no rows; opening its plan seeds it
 * then. That is why this is not only called from the bind dialog.
 *
 * THE COORDINATOR IS THE ONLY OWNER ANYTHING CAN SEED. The sheet's Department column names roles,
 * not people, so the 16 tasks it marks Launch Coordinator go to the pipeline card's owner and
 * everything else starts visibly unassigned. Inventing a default for the rest would make a guess
 * look like a decision. */
export type SeedResult = {
  inserted: number;
  missingTable: boolean;
  error: string | null;
  /** Set when the plan was deliberately not made. NOT an error, and never fails a bind. */
  skipped: "past-window" | null;
};

/* ── A FIELD THAT HAS BEEN RUNNING FOR MONTHS DOES NOT GET A PLAN ──────────────────────────────
 * Ryan, with the dialog open on PRUMC: "its saying link and create the plan but we dont need a
 * plan for ones that have been going for a long time." PRUMC opened 20 Jan 2026 — week 38 of a
 * 20-week plan. All 24 tasks would be written already overdue, and isLive() would drop the plan
 * off /growth/launch the instant it existed.
 *
 * THE RULE IS isLive(), NOT A NEW THRESHOLD. launchPlan.ts already draws this exact line: a plan
 * runs from four weeks before launch to sixteen weeks after, and its own comment says a plan is
 * finished once week 20 is past. Inventing a second number here (90 days, a quarter, anything that
 * sounds round) would be a second rule that disagrees with the one the index already applies.
 *
 * THE GUARD IS HERE AND NOT AT THE CALL SITES because there are two callers and both were wrong:
 * the bind dialog, and the REPAIR pass in LaunchPlanView that seeds a venue bound before 0173
 * applied. Fixing only the dialog would leave a path that re-seeds a dead field's plan the first
 * time somebody opened it.
 *
 * A NULL launch_date IS NOT A PAST WINDOW and is left exactly as it was — it falls through and
 * seeds. It is unreachable from both callers today (the dialog cannot save without a date, and the
 * plan page returns before seeding when the venue has none), so this is a defensive branch rather
 * than a decision about what a dateless plan should mean. */
export async function seedLaunchPlan(
  venueId: number,
  coordinatorUserId: string | null,
  launchIso: string | null,
  opts: { force?: boolean } = {},
): Promise<SeedResult> {
  if (launchIso && !isLive(launchIso) && !opts.force) {
    return { inserted: 0, missingTable: false, error: null, skipped: "past-window" };
  }
  const existing = await supabase
    .from("field_launch_tasks")
    .select("template_key")
    .eq("venue_id", venueId)
    .not("template_key", "is", null);
  if (existing.error) {
    if (isMissingTable(existing.error)) return { inserted: 0, missingTable: true, error: null, skipped: null };
    return { inserted: 0, missingTable: false, error: existing.error.message, skipped: null };
  }
  const have = new Set((existing.data ?? []).map((r) => (r as { template_key: string }).template_key));
  /* sort_order IS THE PLAYBOOK'S OWN ORDER, taken from the template index rather than from the
   * filtered list — a repair pass that inserts three missing rows must not renumber them 1, 2, 3
   * and jump them to the top of their phase. */
  const rows = TEMPLATE.map((t, i) => ({ t, i }))
    .filter(({ t }) => !have.has(t.key))
    .map(({ t, i }) => ({
      venue_id: venueId,
      template_key: t.key,
      title: t.title,
      scope: t.scope,
      department: t.department,
      week_start: t.w1,
      week_end: t.w2,
      sort_order: i + 1,
      owner_user_id: t.coordinator ? coordinatorUserId : null,
    }));
  if (rows.length === 0) return { inserted: 0, missingTable: false, error: null, skipped: null };

  const ins = await supabase.from("field_launch_tasks").insert(rows);
  if (ins.error) {
    if (isMissingTable(ins.error)) return { inserted: 0, missingTable: true, error: null, skipped: null };
    /* 23505 IS THE OTHER TAB WINNING, NOT A FAILURE. The plan it wrote is the same plan, so this
     * reports success and the caller reloads onto its rows. */
    if (ins.error.code === "23505") return { inserted: 0, missingTable: false, error: null, skipped: null };
    return { inserted: 0, missingTable: false, error: ins.error.message, skipped: null };
  }
  return { inserted: rows.length, missingTable: false, error: null, skipped: null };
}

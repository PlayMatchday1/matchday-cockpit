// OPEX PROJECTIONS — money that MIGHT leave (Ryan, 2026-10-03): a field we might open, a manager we
// might hire, equipment we might buy. Table public.opex_projections (migration 0202).
//
// OPEX ONLY, BY CONSTRUCTION. Only OpExCalendarView imports this file, and only it passes
// projections to buildOpexCalendarAsOf. useFinanceData never loads the table, so Field Costs, the
// Expenses ledger, Cost, Cities, the P&L and the 2027 plan cannot see one. A projection never
// creates a venue or an expense. It is added, edited and deleted on the OpEx page and nowhere else.
//
// A PROJECTION STAYS PROJECTED. Its payments are never "paid", whatever the date: OpEx marks a
// scheduled field payment paid once its day passes, and that rule does not apply here.
//
// WRITES: one request each, no retry, each followed by a fin_change_log entry. Until the table
// exists every save reports "not saved" with the reason, rather than looking like it worked.

import { supabase } from "./supabase";
import { logChange } from "./financeAudit";

import { type OpexProjection, type ProjCat, type ProjRepeat, type ProjectionDraft } from "./opexProjectionModel";
export * from "./opexProjectionModel";

/* ── THE TABLE ─────────────────────────────────────────────────────────────────────────────── */

/** True when PostgREST says the table is not there (migration 0202 not applied yet). */
const isMissingTable = (e: { code?: string; message?: string } | null) =>
  !!e && (e.code === "42P01" || e.code === "PGRST205" || (/opex_projections/.test(e.message ?? "") && /(does not exist|schema cache)/i.test(e.message ?? "")));

export const MISSING_TABLE_MSG = "Not saved: the projections table does not exist yet (migration 0202 has not been applied).";

const COLS = "id, category, description, amount, first_date, repeat, end_date, skipped_dates";

function clean(r: Record<string, unknown>): OpexProjection {
  return {
    id: Number(r.id),
    category: r.category as ProjCat,
    description: String(r.description ?? ""),
    amount: Number(r.amount),
    first_date: String(r.first_date),
    repeat: r.repeat as ProjRepeat,
    end_date: (r.end_date as string | null) ?? null,
    skipped_dates: Array.isArray(r.skipped_dates) ? (r.skipped_dates as string[]) : [],
  };
}

export async function fetchProjections(): Promise<{ rows: OpexProjection[]; missing: boolean; error: string | null }> {
  const { data, error } = await supabase.from("opex_projections").select(COLS).order("first_date");
  if (error) return { rows: [], missing: isMissingTable(error), error: isMissingTable(error) ? null : error.message };
  return { rows: (data ?? []).map((r) => clean(r as Record<string, unknown>)), missing: false, error: null };
}

/** What is wrong with a draft, in words, or null. Checked before anything is sent. */
export function draftProblem(d: ProjectionDraft): string | null {
  if (!d.description.trim()) return "Say what it is.";
  if (!Number.isFinite(d.amount) || d.amount <= 0) return "The amount must be more than $0.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.first_date)) return "Pick the first pay date.";
  if (d.end_date && d.end_date < d.first_date) return "The end date is before the first pay date.";
  return null;
}

type Result = { ok: true; row?: OpexProjection; warning?: string } | { ok: false; error: string };

/* THE AUDIT ROW IS WRITTEN AFTER THE SAVE LANDS. If it fails the save still stands, so the result
 * says so plainly ("saved, but…") instead of reporting a failure that would invite a second save. */
async function audit(opts: Parameters<typeof logChange>[0]): Promise<string | undefined> {
  try { await logChange(opts); return undefined; }
  catch (e) { return `Saved, but the change log entry failed: ${e instanceof Error ? e.message : String(e)}`; }
}
const fail = (e: { code?: string; message?: string }): Result =>
  ({ ok: false, error: isMissingTable(e) ? MISSING_TABLE_MSG : `Not saved: ${e.message ?? "unknown error"}` });

export async function insertProjection(d: ProjectionDraft, by: string): Promise<Result> {
  const problem = draftProblem(d);
  if (problem) return { ok: false, error: problem };
  const row = { ...d, description: d.description.trim(), created_by: by };
  const { data, error } = await supabase.from("opex_projections").insert(row).select(COLS).single();
  if (error) return fail(error);
  const saved = clean(data as Record<string, unknown>);
  const warning = await audit({ tableName: "opex_projections", rowId: saved.id, action: "insert", changedBy: by, before: null, after: saved });
  return { ok: true, row: saved, warning };
}

/** Sends only the fields that changed. A save with nothing changed sends nothing. */
export async function updateProjection(before: OpexProjection, d: ProjectionDraft, by: string): Promise<Result> {
  const problem = draftProblem(d);
  if (problem) return { ok: false, error: problem };
  const next = { ...d, description: d.description.trim() };
  const diff: Record<string, unknown> = {};
  const was: Record<string, unknown> = { id: before.id };
  for (const k of Object.keys(next) as (keyof ProjectionDraft)[]) {
    if (JSON.stringify(before[k] ?? null) === JSON.stringify(next[k] ?? null)) continue;
    diff[k] = next[k] ?? null;
    was[k] = before[k] ?? null;
  }
  if (Object.keys(diff).length === 0) return { ok: true, row: before };
  const { data, error } = await supabase.from("opex_projections")
    .update({ ...diff, updated_by: by, updated_at: new Date().toISOString() })
    .eq("id", before.id).select(COLS).single();
  if (error) return fail(error);
  const saved = clean(data as Record<string, unknown>);
  const warning = await audit({ tableName: "opex_projections", rowId: saved.id, action: "update", changedBy: by, before: was, after: saved });
  return { ok: true, row: saved, warning };
}

/** Removes ONE payment of a repeating projection: its date joins skipped_dates. */
export async function skipProjectionDate(p: OpexProjection, iso: string, by: string): Promise<Result> {
  const skipped = [...new Set([...(p.skipped_dates ?? []), iso])].sort();
  const { data, error } = await supabase.from("opex_projections")
    .update({ skipped_dates: skipped, updated_by: by, updated_at: new Date().toISOString() })
    .eq("id", p.id).select(COLS).single();
  if (error) return fail(error);
  const saved = clean(data as Record<string, unknown>);
  const warning = await audit({ tableName: "opex_projections", rowId: p.id, action: "update", changedBy: by, before: { id: p.id, skipped_dates: p.skipped_dates }, after: saved, note: `removed the ${iso} payment only` });
  return { ok: true, row: saved, warning };
}

/** Removes the projection — every payment, every month. */
export async function deleteProjection(p: OpexProjection, by: string): Promise<Result> {
  // .select() READS BACK what was deleted: a delete that matched no row is a 2xx with nothing gone.
  const { data, error } = await supabase.from("opex_projections").delete().eq("id", p.id).select("id");
  if (error) return fail(error);
  if (!data || data.length !== 1) return { ok: false, error: "Not removed: no projection with that id was found. Reload the page." };
  const warning = await audit({ tableName: "opex_projections", rowId: p.id, action: "delete", changedBy: by, before: p, after: null });
  return { ok: true, warning };
}

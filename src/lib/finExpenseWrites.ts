// The ONE way a fin_expenses row is created / changed / deleted from the UI.
// Extracted from ExpenseAdminView so the OpEx Calendar and the Expenses tab
// share a single write path — same manual_entry lock, same change-log audit,
// same updated_at/updated_by stamping. Do not write fin_expenses anywhere else.
//
// These functions perform the DB write + the audit row only. Callers refresh
// their view afterwards (both surfaces call refetchFinanceData()).

import { supabase } from "@/lib/supabase";
import { logChange } from "@/lib/financeAudit";
import type { AppUser } from "@/lib/useAuth";
import type { FinExpense } from "@/lib/useFinanceData";

// Categories a background job owns: the /api/sync/cron Manager Pay recompute
// (src/lib/managerPayCompute.ts) deletes every fin_expenses row WHERE
// category='Match Manager Pay' AND date>=cutover and re-inserts from /managers,
// so any hand edit to such a row is silently overwritten on the next cron.
// Recon gate 0i found 56 pre-cutover MMP rows carrying manual_entry=true — the
// manual_entry flag alone would let those through, so the category guard lives
// here (not just in the UI) as the real lock. Field Costs is computed from
// fin_venues and is not a fin_expenses category, so MMP is the only member.
export const RECOMPUTE_OWNED_CATEGORIES = new Set<string>(["Match Manager Pay"]);

// The mutable columns. `month` must stay consistent with `date` (it is the
// calendar/Cash-Flow bucket key), so callers that change the date also pass the
// recomputed month.
export type FinExpenseFields = {
  date: string;
  month: string;
  city: string | null;
  category: string;
  vendor: string | null;
  amount: number;
  notes: string | null;
};

// Insert a manual row. Only manual_entry=true rows are ever editable later.
export async function insertFinExpense(
  fields: FinExpenseFields,
  user: AppUser,
): Promise<Record<string, unknown>> {
  if (!user.email) throw new Error("Not signed in");
  const { data: inserted, error } = await supabase
    .from("fin_expenses")
    .insert({ ...fields, manual_entry: true })
    .select()
    .single();
  if (error) throw new Error(error.message);
  await logChange({
    tableName: "fin_expenses",
    rowId: (inserted as { id: number }).id,
    action: "insert",
    changedBy: user.email,
    after: inserted as Record<string, unknown>,
  });
  return inserted as Record<string, unknown>;
}

// Update a manual row. Locked (manual_entry=false, i.e. imported / recompute-
// owned) rows are refused. `updates` is the changed columns only; this stamps
// updated_at + updated_by on top. The change log records before/after.
export async function updateFinExpense(
  row: FinExpense,
  updates: Partial<FinExpenseFields>,
  user: AppUser,
): Promise<Record<string, unknown>> {
  if (!user.email) throw new Error("Not signed in");
  if (RECOMPUTE_OWNED_CATEGORIES.has(row.category)) {
    throw new Error(
      `${row.category} is recompute-owned — edit it on the Manager Pay page, not here.`,
    );
  }
  if (!row.manual_entry) throw new Error("Row is locked.");
  const before = { ...row };
  const { data: updated, error } = await supabase
    .from("fin_expenses")
    .update({ ...updates, updated_at: new Date().toISOString(), updated_by: user.id })
    .eq("id", row.id)
    .select()
    .single();
  if (error) throw new Error(error.message);
  await logChange({
    tableName: "fin_expenses",
    rowId: row.id,
    action: "update",
    changedBy: user.email,
    before: before as unknown as Record<string, unknown>,
    after: updated as Record<string, unknown>,
  });
  return updated as Record<string, unknown>;
}

// Delete a manual row. Locked rows are refused. Audit is written BEFORE the
// delete so a failure can't leave an unlogged deletion.
export async function deleteFinExpense(row: FinExpense, user: AppUser): Promise<void> {
  if (!user.email) throw new Error("Not signed in");
  if (RECOMPUTE_OWNED_CATEGORIES.has(row.category)) {
    throw new Error(
      `${row.category} is recompute-owned — manage it on the Manager Pay page, not here.`,
    );
  }
  if (!row.manual_entry) throw new Error("Row is locked.");
  await logChange({
    tableName: "fin_expenses",
    rowId: row.id,
    action: "delete",
    changedBy: user.email,
    before: row as unknown as Record<string, unknown>,
  });
  // .select() TURNS A ZERO-ROW DELETE INTO AN OBSERVABLE ONE. Checking `error` alone is how the
  // account-delete bug survived for months: RLS makes a blocked write match zero rows and return
  // 204 with error: null, so "it worked" and "it did nothing" are the same response.
  //
  // Measured on fin_expenses 2026-08-19: an authenticated client delete DOES land here — this
  // table's RLS permits it, unlike app_users. The verification is not because it is currently
  // broken; it is so a policy change cannot silently break it later.
  const { data, error } = await supabase.from("fin_expenses").delete().eq("id", row.id).select("id");
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) {
    throw new Error(
      "NOT APPLIED — the delete matched no rows and nothing was removed. The entry is still there; " +
      "reload before trying again.",
    );
  }
  // READ BACK. A 2xx is not proof, and this row is a real figure in OpEx and Cash Flow.
  const { data: still } = await supabase.from("fin_expenses").select("id").eq("id", row.id).maybeSingle();
  if (still) {
    throw new Error(
      "NOT APPLIED — the delete reported success but the entry is still on file. Nothing was retried.",
    );
  }
}

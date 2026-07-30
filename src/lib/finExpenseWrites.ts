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
  if (!row.manual_entry) throw new Error("Row is locked.");
  await logChange({
    tableName: "fin_expenses",
    rowId: row.id,
    action: "delete",
    changedBy: user.email,
    before: row as unknown as Record<string, unknown>,
  });
  const { error } = await supabase.from("fin_expenses").delete().eq("id", row.id);
  if (error) throw new Error(error.message);
}

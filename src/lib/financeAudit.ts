import { supabase } from "./supabase";

export type AuditTable =
  | "fin_revenue"
  | "fin_expenses"
  | "fin_venue_cost_overrides"
  | "fin_venues";
export type AuditAction = "insert" | "update" | "delete";

type LogChangeOpts = {
  tableName: AuditTable;
  rowId: number;
  action: AuditAction;
  changedBy: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  note?: string | null;
};

export async function logChange(opts: LogChangeOpts): Promise<void> {
  if (!opts.changedBy) {
    throw new Error("Not signed in");
  }
  const { error } = await supabase.from("fin_change_log").insert({
    table_name: opts.tableName,
    row_id: opts.rowId,
    action: opts.action,
    changed_by: opts.changedBy,
    before_json: opts.before ?? null,
    after_json: opts.after ?? null,
    note: opts.note ?? null,
  });
  if (error) throw new Error(`Audit log write failed: ${error.message}`);
}

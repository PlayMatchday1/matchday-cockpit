import { supabase } from "./supabase";
import type { Goal } from "./types";

export async function swapGoalSortOrder(
  a: Goal,
  b: Goal,
): Promise<{ error: string | null }> {
  if (a.sort_order === null || b.sort_order === null) {
    return { error: "Sort order not initialized for these goals." };
  }
  const aOrder = a.sort_order;
  const bOrder = b.sort_order;

  const r1 = await supabase
    .from("goals")
    .update({ sort_order: bOrder })
    .eq("id", a.id);
  if (r1.error) return { error: r1.error.message };

  const r2 = await supabase
    .from("goals")
    .update({ sort_order: aOrder })
    .eq("id", b.id);
  if (r2.error) return { error: r2.error.message };

  return { error: null };
}

export async function getNextSortOrder(
  scope: string,
  city: string | null,
): Promise<number> {
  let q = supabase.from("goals").select("sort_order").eq("scope", scope);
  q = city ? q.eq("city", city) : q.is("city", null);
  const { data } = await q
    .order("sort_order", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  const row = data as { sort_order: number | null } | null;
  return (row?.sort_order ?? 0) + 1;
}

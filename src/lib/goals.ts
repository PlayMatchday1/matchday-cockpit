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

function parseGoalDate(s: string): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [yr, mo, dy] = s.split("-").map(Number);
    return new Date(yr, mo - 1, dy);
  }
  return new Date(s);
}

export function formatGoalDate(s: string | null): string {
  if (!s) return "";
  return parseGoalDate(s).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function formatGoalDateShort(s: string | null): string {
  if (!s) return "";
  return parseGoalDate(s).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

export function isTargetPastDue(targetDate: string | null): boolean {
  if (!targetDate) return false;
  const target = parseGoalDate(targetDate);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return target < today;
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

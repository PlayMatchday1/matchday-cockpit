"use client";

// Client hook for fin_opex_entries: load + create/update/delete. Local
// state updates optimistically after each mutation so the calendar
// re-renders without a full refetch. RLS allows any authenticated
// cockpit user (the Finance page guard enforces admin access).

import { useCallback, useEffect, useState } from "react";
import { supabase } from "./supabase";
import type { OpexDraft, OpexEntry } from "./opex";

export function useOpexEntries() {
  const [entries, setEntries] = useState<OpexEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("fin_opex_entries")
      .select("*")
      .order("scheduled_date");
    if (error) setError(error.message);
    else {
      setEntries((data ?? []) as OpexEntry[]);
      setError(null);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const create = useCallback(
    async (draft: OpexDraft, createdBy: string | null) => {
      const { data, error } = await supabase
        .from("fin_opex_entries")
        .insert({ ...draft, created_by: createdBy })
        .select("*")
        .single();
      if (error) throw new Error(error.message);
      setEntries((prev) => [...prev, data as OpexEntry]);
      return data as OpexEntry;
    },
    [],
  );

  const update = useCallback(async (id: string, draft: OpexDraft) => {
    const { data, error } = await supabase
      .from("fin_opex_entries")
      .update(draft)
      .eq("id", id)
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    setEntries((prev) => prev.map((e) => (e.id === id ? (data as OpexEntry) : e)));
    return data as OpexEntry;
  }, []);

  const remove = useCallback(async (id: string) => {
    const { error } = await supabase.from("fin_opex_entries").delete().eq("id", id);
    if (error) throw new Error(error.message);
    setEntries((prev) => prev.filter((e) => e.id !== id));
  }, []);

  return { entries, loading, error, reload, create, update, remove };
}

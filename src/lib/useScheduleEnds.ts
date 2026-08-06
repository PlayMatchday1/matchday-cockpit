"use client";

// "Schedule ends" state for Field Ops — when a field's reservation runs out.
// The counterpart hook to useScheduleMarks, over the fin_venues columns added in
// migration 0110 (schedule_end_date, schedule_indefinite, and who/when attribution).
//
// The stored shape is only { date | indefinite | neither }; the FIVE display
// states (Standing / Reserved through / Ends soon / Expired / Not set) are derived
// at RENDER from the date against today — never persisted (see CitiesFieldsLens).
//
// DEGRADE: pre-0110 the columns are absent → the select errors, enabled=false, and
// the column falls back to a read-only "Not set" with no editor. indefinite and a
// date are mutually exclusive; the schema enforces it, and setEnds never sends both.

import { useCallback, useEffect, useState } from "react";
import { supabase } from "./supabase";
import { useAuth } from "./useAuth";

export type ScheduleEnd = {
  endDate: string | null; // YYYY-MM-DD
  indefinite: boolean;
  by: string | null; // resolved name of the app_user who last set it
  on: string | null; // YYYY-MM-DD it was last set
};
export type ScheduleEndsState = {
  ends: Map<number, ScheduleEnd>;
  enabled: boolean;
  loading: boolean;
};

function isMissingColumn(msg: string | undefined): boolean {
  if (!msg) return false;
  return (
    /schedule_end_date|schedule_indefinite|schedule_end_updated/i.test(msg) &&
    /(does not exist|schema cache|could not find|column)/i.test(msg)
  );
}

type EndRow = {
  id: number;
  schedule_end_date: string | null;
  schedule_indefinite: boolean | null;
  schedule_end_updated_by: string | null;
  schedule_end_updated_at: string | null;
};

export function useScheduleEnds() {
  const { appUser } = useAuth();
  const [state, setState] = useState<ScheduleEndsState>({ ends: new Map(), enabled: true, loading: true });
  const [writeError, setWriteError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from("fin_venues")
      .select("id, schedule_end_date, schedule_indefinite, schedule_end_updated_by, schedule_end_updated_at")
      .eq("is_active", true);
    if (error) {
      setState({ ends: new Map(), enabled: !isMissingColumn(error.message), loading: false });
      return;
    }
    const rows = (data ?? []) as EndRow[];
    const ids = [...new Set(rows.map((r) => r.schedule_end_updated_by).filter(Boolean) as string[])];
    const names = new Map<string, string>();
    if (ids.length) {
      const { data: us } = await supabase.from("app_users").select("id, full_name, email").in("id", ids);
      for (const u of us ?? []) names.set(u.id as string, (u.full_name as string) || (u.email as string));
    }
    const m = new Map<number, ScheduleEnd>();
    for (const r of rows) {
      m.set(Number(r.id), {
        endDate: r.schedule_end_date ?? null,
        indefinite: !!r.schedule_indefinite,
        by: r.schedule_end_updated_by ? names.get(r.schedule_end_updated_by) || "Admin" : null,
        on: r.schedule_end_updated_at ? String(r.schedule_end_updated_at).slice(0, 10) : null,
      });
    }
    setState({ ends: m, enabled: true, loading: false });
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Save the reservation end. indefinite XOR date is guaranteed here (never both);
  // the CHECK constraint is the backstop. Optimistic; reverts on write error.
  const setEnds = useCallback(
    async (venueId: number, next: { date: string | null; indefinite: boolean }) => {
      if (!appUser?.id) return;
      const endDate = next.indefinite ? null : next.date; // never both
      const patch = { schedule_end_date: endDate, schedule_indefinite: next.indefinite, schedule_end_updated_by: appUser.id };
      const optimistic = new Map(state.ends);
      optimistic.set(venueId, {
        endDate,
        indefinite: next.indefinite,
        by: appUser.full_name || appUser.email,
        on: new Date().toISOString().slice(0, 10), // optimistic; the trigger stamps the row
      });
      setState((s) => ({ ...s, ends: optimistic }));
      setWriteError(null);
      const res = await supabase.from("fin_venues").update(patch).eq("id", venueId).select("id");
      if (res.error) {
        setWriteError("Couldn’t save the reservation end — it was undone. You may not have permission.");
        void load();
      }
    },
    [appUser, state.ends, load],
  );

  return { ...state, setEnds, reload: load, error: writeError, clearError: () => setWriteError(null) };
}

"use client";

// "No document" marks for Field Ops schedules — the deliberate counterpart to a
// blank Schedule block. A field's schedule is:
//   fin_venues.schedule_url set → "Open schedule" (link wins)
//   venue_schedule_marks row     → "No document" (resolved, attributed)
//   neither                      → still outstanding
//
// Stored in venue_schedule_marks (migration 0094), keyed by venue_id (PK → one
// mark per venue, no double-click duplicate). Optimistic; RLS gates writes to any
// authenticated app_user. marked_at is a server default — never a browser stamp.
// DEGRADE: pre-0094 the table is absent → enabled=false, the "No document" action
// is hidden and the block keeps its existing two states.

import { useCallback, useEffect, useState } from "react";
import { supabase } from "./supabase";
import { useAuth } from "./useAuth";

export type ScheduleMark = { byId: string; by: string; on: string };
export type ScheduleMarksState = {
  marks: Map<number, ScheduleMark>;
  enabled: boolean;
  loading: boolean;
};

function isMissingTable(msg: string | undefined): boolean {
  if (!msg) return false;
  return (
    /venue_schedule_marks/i.test(msg) &&
    /(does not exist|schema cache|relation|could not find)/i.test(msg)
  );
}

export function useScheduleMarks() {
  const { appUser } = useAuth();
  const [state, setState] = useState<ScheduleMarksState>({
    marks: new Map(),
    enabled: true,
    loading: true,
  });
  const [writeError, setWriteError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from("venue_schedule_marks")
      .select("venue_id, marked_at, marked_by");
    if (error) {
      setState({ marks: new Map(), enabled: !isMissingTable(error.message), loading: false });
      return;
    }
    const rows = data ?? [];
    const ids = [...new Set(rows.map((r) => r.marked_by as string))];
    const names = new Map<string, string>();
    if (ids.length) {
      const { data: us } = await supabase
        .from("app_users")
        .select("id, full_name, email")
        .in("id", ids);
      for (const u of us ?? [])
        names.set(u.id as string, (u.full_name as string) || (u.email as string));
    }
    const m = new Map<number, ScheduleMark>();
    for (const r of rows) {
      m.set(Number(r.venue_id), {
        byId: r.marked_by as string,
        by: names.get(r.marked_by as string) || "Admin",
        on: String(r.marked_at).slice(0, 10),
      });
    }
    setState({ marks: m, enabled: true, loading: false });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const setNoDocument = useCallback(
    async (venueId: number) => {
      if (!appUser?.id) return;
      const optimistic = new Map(state.marks);
      optimistic.set(venueId, {
        byId: appUser.id,
        by: appUser.full_name || appUser.email,
        on: new Date().toISOString().slice(0, 10), // optimistic display; server stamps the row
      });
      setState((s) => ({ ...s, marks: optimistic }));
      setWriteError(null);
      const res = await supabase
        .from("venue_schedule_marks")
        .upsert({ venue_id: venueId, marked_by: appUser.id }, { onConflict: "venue_id", ignoreDuplicates: true });
      if (res.error) {
        setWriteError("Couldn’t save “No document” — it was undone. You may not have permission.");
        void load();
      }
    },
    [appUser, state.marks, load],
  );

  const clear = useCallback(
    async (venueId: number) => {
      if (!appUser?.id) return;
      const optimistic = new Map(state.marks);
      optimistic.delete(venueId);
      setState((s) => ({ ...s, marks: optimistic }));
      setWriteError(null);
      const res = await supabase.from("venue_schedule_marks").delete().eq("venue_id", venueId);
      if (res.error) {
        setWriteError("Couldn’t undo — it was restored. You may not have permission.");
        void load();
      }
    },
    [appUser, state.marks, load],
  );

  return { ...state, setNoDocument, clear, reload: load, error: writeError, clearError: () => setWriteError(null) };
}

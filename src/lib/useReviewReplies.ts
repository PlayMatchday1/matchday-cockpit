"use client";

// Reply marks for the Reviews page — "we answered this player", stored in
// review_replies (migration 0089), keyed by the review's api_id. Optimistic
// insert/delete; RLS gates writes to admins.
//
// DEGRADE: until the migration is applied the table does not exist. The first
// read returns a "relation does not exist / schema cache" error; we set
// enabled=false so the page can render the tick column disabled with a one-line
// note instead of throwing. No other failure flips enabled.

import { useCallback, useEffect, useState } from "react";
import { supabase } from "./supabase";
import { useAuth } from "./useAuth";

export type ReplyMark = { byId: string; by: string; on: string };

export type ReviewRepliesState = {
  replies: Map<number, ReplyMark>;
  enabled: boolean; // false → migration not applied yet
  loading: boolean;
};

function isMissingTable(msg: string | undefined): boolean {
  if (!msg) return false;
  return (
    /review_replies/i.test(msg) &&
    /(does not exist|schema cache|relation|could not find)/i.test(msg)
  );
}

export function useReviewReplies() {
  const { appUser } = useAuth();
  const [state, setState] = useState<ReviewRepliesState>({
    replies: new Map(),
    enabled: true,
    loading: true,
  });
  // A rejected write (RLS denial, lost connection) must never look like a
  // successful click: we revert the optimistic tick AND surface this message.
  const [writeError, setWriteError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from("review_replies")
      .select("review_id, replied_at, replied_by");
    if (error) {
      setState({
        replies: new Map(),
        enabled: !isMissingTable(error.message),
        loading: false,
      });
      return;
    }
    const rows = data ?? [];
    const ids = [...new Set(rows.map((r) => r.replied_by as string))];
    const names = new Map<string, string>();
    if (ids.length) {
      const { data: us } = await supabase
        .from("app_users")
        .select("id, full_name, email")
        .in("id", ids);
      for (const u of us ?? [])
        names.set(u.id as string, (u.full_name as string) || (u.email as string));
    }
    const m = new Map<number, ReplyMark>();
    for (const r of rows) {
      m.set(Number(r.review_id), {
        byId: r.replied_by as string,
        by: names.get(r.replied_by as string) || "Admin",
        on: String(r.replied_at).slice(0, 10),
      });
    }
    setState({ replies: m, enabled: true, loading: false });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Toggle the mark for one review. Optimistic; reverts + reloads on error.
  const toggle = useCallback(
    async (reviewId: number) => {
      if (!appUser?.id) return;
      const had = state.replies.has(reviewId);
      const optimistic = new Map(state.replies);
      if (had) {
        optimistic.delete(reviewId);
      } else {
        optimistic.set(reviewId, {
          byId: appUser.id,
          by: appUser.full_name || appUser.email,
          on: new Date().toISOString().slice(0, 10),
        });
      }
      setState((s) => ({ ...s, replies: optimistic }));
      setWriteError(null);

      const res = had
        ? await supabase.from("review_replies").delete().eq("review_id", reviewId)
        : await supabase
            .from("review_replies")
            .insert({ review_id: reviewId, replied_by: appUser.id });
      if (res.error) {
        // Denied or failed: revert the optimistic state to server truth and tell
        // the user. A permission denial must not read as a successful click.
        setWriteError(
          had
            ? "Couldn’t remove that reply mark — the change was undone. You may not have permission."
            : "Couldn’t save that reply mark — the tick was undone. You may not have permission.",
        );
        void load();
      }
    },
    [appUser, state.replies, load],
  );

  return { ...state, toggle, reload: load, error: writeError, clearError: () => setWriteError(null) };
}

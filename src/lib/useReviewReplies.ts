"use client";

// Resolution marks for the Reviews page — two ways a review can be "handled":
//   kind='replied'          → we answered the player (green "Replied").
//   kind='no_reply_needed'  → deliberately nothing to answer (neutral chip),
//                             optional short note for the reason.
//   (no row)                → still open; the only state counted as owed.
//
// Stored in review_replies (migration 0089), keyed by the review's api_id (PK →
// one mark per review, so a double-click can't duplicate). `kind`/`note` land in
// migration 0093. Optimistic writes; RLS (0090) gates them to any authenticated
// app_user. replied_at is a server default — never a browser timestamp.
//
// DEGRADE, two levels:
//   - table missing (pre-0089) → enabled=false, the column renders read-only.
//   - kind column missing (0089/0090 applied, 0093 not) → noReplyNeededEnabled=
//     false: replied marks work as before, the "No reply needed" action is hidden
//     until 0093 is applied. Neither ever throws.

import { useCallback, useEffect, useState } from "react";
import { supabase } from "./supabase";
import { useAuth } from "./useAuth";

export type MarkKind = "replied" | "no_reply_needed";
export type ReplyMark = {
  byId: string;
  by: string;
  on: string;
  kind: MarkKind;
  note: string | null;
};

export type ReviewRepliesState = {
  replies: Map<number, ReplyMark>;
  enabled: boolean; // false → review_replies table missing (pre-0089)
  noReplyNeededEnabled: boolean; // false → kind column missing (pre-0093)
  loading: boolean;
};

function isMissingTable(msg: string | undefined): boolean {
  if (!msg) return false;
  return (
    /review_replies/i.test(msg) &&
    /(does not exist|schema cache|relation|could not find)/i.test(msg)
  );
}
function isMissingKindColumn(msg: string | undefined): boolean {
  if (!msg) return false;
  return /\b(kind|note)\b/i.test(msg) && /(does not exist|schema cache|could not find)/i.test(msg);
}

export function useReviewReplies() {
  const { appUser } = useAuth();
  const [state, setState] = useState<ReviewRepliesState>({
    replies: new Map(),
    enabled: true,
    noReplyNeededEnabled: true,
    loading: true,
  });
  const [writeError, setWriteError] = useState<string | null>(null);

  const load = useCallback(async () => {
    // Try the full shape first; fall back to the pre-0093 columns so the page
    // still works (replied-only) before the kind/note migration is applied.
    let rows: Record<string, unknown>[] | null = null;
    let kindEnabled = true;
    const full = await supabase
      .from("review_replies")
      .select("review_id, replied_at, replied_by, kind, note");
    if (full.error && isMissingKindColumn(full.error.message)) {
      kindEnabled = false;
      const legacy = await supabase
        .from("review_replies")
        .select("review_id, replied_at, replied_by");
      if (legacy.error) {
        setState({ replies: new Map(), enabled: !isMissingTable(legacy.error.message), noReplyNeededEnabled: false, loading: false });
        return;
      }
      rows = legacy.data ?? [];
    } else if (full.error) {
      setState({ replies: new Map(), enabled: !isMissingTable(full.error.message), noReplyNeededEnabled: false, loading: false });
      return;
    } else {
      rows = full.data ?? [];
    }

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
        kind: (r.kind as MarkKind) ?? "replied",
        note: (r.note as string | null) ?? null,
      });
    }
    setState({ replies: m, enabled: true, noReplyNeededEnabled: kindEnabled, loading: false });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Set one review to a resolved state. Optimistic; reverts + reloads on error.
  // Insert-from-open only (the UI shows the two actions only when there is no
  // mark), so an upsert with ignoreDuplicates makes a double-click a no-op rather
  // than a PK-conflict error. replied_at is the server default — never sent.
  const setMark = useCallback(
    async (reviewId: number, kind: MarkKind, note?: string) => {
      if (!appUser?.id) return;
      const optimistic = new Map(state.replies);
      optimistic.set(reviewId, {
        byId: appUser.id,
        by: appUser.full_name || appUser.email,
        on: new Date().toISOString().slice(0, 10), // optimistic display only; server stamps the row
        kind,
        note: note?.trim() ? note.trim() : null,
      });
      setState((s) => ({ ...s, replies: optimistic }));
      setWriteError(null);

      const payload: Record<string, unknown> = { review_id: reviewId, replied_by: appUser.id };
      if (state.noReplyNeededEnabled) {
        payload.kind = kind;
        payload.note = note?.trim() ? note.trim() : null;
      }
      const res = await supabase
        .from("review_replies")
        .upsert(payload, { onConflict: "review_id", ignoreDuplicates: true });
      if (res.error) {
        setWriteError("Couldn’t save that mark — it was undone. You may not have permission.");
        void load();
      }
    },
    [appUser, state.replies, state.noReplyNeededEnabled, load],
  );

  // Undo any mark → back to open. Attribution of the undo is the delete itself.
  const clear = useCallback(
    async (reviewId: number) => {
      if (!appUser?.id) return;
      const optimistic = new Map(state.replies);
      optimistic.delete(reviewId);
      setState((s) => ({ ...s, replies: optimistic }));
      setWriteError(null);
      const res = await supabase.from("review_replies").delete().eq("review_id", reviewId);
      if (res.error) {
        setWriteError("Couldn’t undo that mark — it was restored. You may not have permission.");
        void load();
      }
    },
    [appUser, state.replies, load],
  );

  return { ...state, setMark, clear, reload: load, error: writeError, clearError: () => setWriteError(null) };
}

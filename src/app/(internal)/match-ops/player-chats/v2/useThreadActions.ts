"use client";

// THE THREAD ACTIONS of Player Chats 2.0 — the SAME routes, bodies and optimistic patches as the old
// page's handlers in CrmClient.tsx (assign, follow-up star, no-reply dismiss, close/reopen, bulk
// close, undo). Kept as a copy rather than a shared refactor so the old page, which stays live for
// everyone else, is not touched by this rebuild. Every route re-checks its own permission.
//
//   PATCH /api/crm/threads/{id}/assign      { user_id }
//   POST  /api/crm/threads/{id}/follow-up   { follow_up }
//   POST  /api/crm/threads/{id}/no-reply    { action: "dismiss" | "reactivate" }
//   POST  /api/crm/threads/{id}/status      { action: "close" | "reopen" }
//   POST  /api/crm/threads/bulk-status      { action: "close" | "undo_close", thread_ids }

import { useCallback, useEffect, useRef, useState } from "react";
import { bearerHeaders, useCrmConversation, type ThreadListRow } from "@/lib/crmConversation";
import type { Assignee } from "@/components/AssigneeChip";

export function useThreadActions() {
  const { threads, setThreads, setDetail, loadThreads } = useCrmConversation();

  const onAssign = useCallback(async (threadId: string, userId: string | null) => {
    const headers = await bearerHeaders();
    if (!headers) return;
    try {
      const res = await fetch(`/api/crm/threads/${threadId}/assign`, { method: "PATCH", headers, body: JSON.stringify({ user_id: userId }) });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || `HTTP ${res.status}`); }
      const j = (await res.json()) as { thread: ThreadListRow; assignee: Assignee | null };
      setThreads((prev) => prev.map((x) => x.id === threadId ? { ...x, assigned_to_user_id: j.thread.assigned_to_user_id, assigned_at: j.thread.assigned_at, assignee: j.assignee } : x));
      setDetail((prev) => prev && prev.thread.id === threadId
        ? { ...prev, thread: { ...prev.thread, assigned_to_user_id: j.thread.assigned_to_user_id, assigned_at: j.thread.assigned_at }, assignee: j.assignee } : prev);
      void loadThreads();
    } catch (err) { console.error("[crm2] assign failed", err); }
  }, [setThreads, setDetail, loadThreads]);

  const onToggleFollowUp = useCallback(async (threadId: string, desired: boolean) => {
    const patch = (value: boolean) => {
      setThreads((prev) => prev.map((t) => (t.id === threadId ? { ...t, is_follow_up: value } : t)));
      setDetail((prev) => prev && prev.thread.id === threadId ? { ...prev, thread: { ...prev.thread, is_follow_up: value } } : prev);
    };
    patch(desired);
    const headers = await bearerHeaders();
    if (!headers) { patch(!desired); return; }
    try {
      const res = await fetch(`/api/crm/threads/${threadId}/follow-up`, { method: "POST", headers, body: JSON.stringify({ follow_up: desired }) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      void loadThreads();
    } catch (err) { console.error("[crm2] follow-up toggle failed", err); patch(!desired); }
  }, [setThreads, setDetail, loadThreads]);

  // "Done · no reply needed": the thread leaves Needs reply without a message or a close. Reply
  // anyway clears it.
  const onSetNoReply = useCallback(async (threadId: string, action: "dismiss" | "reactivate") => {
    const value = action === "dismiss" ? new Date().toISOString() : null;
    const patch = (v: string | null) => {
      setThreads((prev) => prev.map((t) => (t.id === threadId ? { ...t, no_reply_needed_at: v } : t)));
      setDetail((prev) => prev && prev.thread.id === threadId ? { ...prev, thread: { ...prev.thread, no_reply_needed_at: v } } : prev);
    };
    const prevValue = threads.find((t) => t.id === threadId)?.no_reply_needed_at ?? null;
    patch(value);
    const headers = await bearerHeaders();
    if (!headers) { patch(prevValue); return; }
    try {
      const res = await fetch(`/api/crm/threads/${threadId}/no-reply`, { method: "POST", headers, body: JSON.stringify({ action }) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      void loadThreads();
    } catch (err) { console.error("[crm2] no-reply toggle failed", err); patch(prevValue); }
  }, [threads, setThreads, setDetail, loadThreads]);

  // Undo toast after a close (single or bulk), five seconds, the latest batch only.
  const [closeToast, setCloseToast] = useState<{ threadIds: string[] } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const showCloseToast = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    if (timer.current) clearTimeout(timer.current);
    setCloseToast({ threadIds: ids });
    timer.current = setTimeout(() => setCloseToast(null), 5000);
  }, []);

  const onSetStatus = useCallback(async (threadId: string, action: "close" | "reopen") => {
    const next = action === "close" ? "closed" : "open";
    setThreads((prev) => prev.map((t) => (t.id === threadId ? { ...t, status: next } : t)));
    setDetail((prev) => prev && prev.thread.id === threadId ? { ...prev, thread: { ...prev.thread, status: next } } : prev);
    if (action === "close") showCloseToast([threadId]);
    const headers = await bearerHeaders();
    if (!headers) { void loadThreads(); return; }
    try {
      const res = await fetch(`/api/crm/threads/${threadId}/status`, { method: "POST", headers, body: JSON.stringify({ action }) });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || `HTTP ${res.status}`); }
    } catch (err) { console.error("[crm2] status change failed", err); }
    finally { void loadThreads(); }
  }, [setThreads, setDetail, loadThreads, showCloseToast]);

  const onBulkClose = useCallback(async (ids: string[]) => {
    if (ids.length === 0) return;
    const set = new Set(ids);
    setThreads((prev) => prev.map((t) => (set.has(t.id) ? { ...t, status: "closed" } : t)));
    const headers = await bearerHeaders();
    if (!headers) { void loadThreads(); return; }
    try {
      const res = await fetch(`/api/crm/threads/bulk-status`, { method: "POST", headers, body: JSON.stringify({ action: "close", thread_ids: ids }) });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || `HTTP ${res.status}`); }
      const j = (await res.json()) as { closed_ids?: string[] };
      showCloseToast(j.closed_ids?.length ? j.closed_ids : ids);
    } catch (err) { console.error("[crm2] bulk close failed", err); }
    finally { void loadThreads(); }
  }, [setThreads, loadThreads, showCloseToast]);

  const onUndoClose = useCallback(async (ids: string[]) => {
    if (ids.length === 0) return;
    if (timer.current) clearTimeout(timer.current);
    setCloseToast(null);
    const set = new Set(ids);
    setThreads((prev) => prev.map((t) => (set.has(t.id) ? { ...t, status: "open" } : t)));
    setDetail((prev) => prev && set.has(prev.thread.id) ? { ...prev, thread: { ...prev.thread, status: "open" } } : prev);
    const headers = await bearerHeaders();
    if (!headers) { void loadThreads(); return; }
    try {
      const res = await fetch(`/api/crm/threads/bulk-status`, { method: "POST", headers, body: JSON.stringify({ action: "undo_close", thread_ids: ids }) });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || `HTTP ${res.status}`); }
    } catch (err) { console.error("[crm2] undo close failed", err); }
    finally { void loadThreads(); }
  }, [setThreads, setDetail, loadThreads]);

  return { onAssign, onToggleFollowUp, onSetNoReply, onSetStatus, onBulkClose, onUndoClose, closeToast, dismissToast: () => setCloseToast(null) };
}

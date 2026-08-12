"use client";

// Player Chat. Three-pane desktop / single-pane mobile layout.
// Underlying data layer, route (/chats), and DB tables (crm_threads,
// crm_messages) are unchanged.
//
// Composition:
//
//   This component (CrmClient)
//     <ChatsHeader />        : title bar, Players/Matches segmented
//                              control, merged filter row, status
//     ┌──────────────┬───────────────────┬──────────────┐
//     │ InboxPane    │ ConversationPane  │ ContextPanel │
//     │ (280px on    │ (flex-1)          │ (240px on    │
//     │  lg:, full   │                   │  lg:, sheet  │
//     │  width on    │                   │  on mobile)  │
//     │  mobile when │                   │              │
//     │  no thread)  │                   │              │
//     └──────────────┴───────────────────┴──────────────┘
//
// URL state owned here:
//   ?threadId=…   — selected thread (drives center pane on
//                   desktop; switches between full-screen list
//                   and full-screen conversation on mobile)
//   ?view=…       — ticket status view: open (default, omitted) |
//                   awaiting | mine | starred | closed
//
// Realtime: postgres_changes on crm_threads (INSERT + UPDATE) and
// crm_messages (INSERT + UPDATE — UPDATE added in PR #32 for
// delivery_status). Listener subscribes once on mount, dedupes via
// the cached operators map for assignee resolution.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ChevronLeft,
  CircleCheck,
  Info,
  Pin,
  RotateCcw,
  Star,
} from "lucide-react";
import EnablePushNotificationsButton from "@/components/EnablePushNotificationsButton";
import { whatsappWindowExpired } from "@/lib/crmWindow";
import {
  useCrmConversation,
  bearerHeaders,
  markThreadRead,
  type ThreadListRow,
  type Message,
  type ThreadDetail,
} from "@/lib/crmConversation";
import { useAuth } from "@/lib/useAuth";
import { UNKNOWN_CITY } from "@/lib/cityColors";
import CityChip from "@/components/CityChip";
import AssigneeChip, { type Assignee } from "@/components/AssigneeChip";
import ChannelChip, {
  channelDisplay,
  type CrmChannel,
} from "@/components/ChannelChip";
import PlayerAvatar from "@/components/PlayerAvatar";
import type { MatchStatus } from "@/components/MatchStatusPill";
import { type StatusFilter } from "./components/FilterBar";
import { isAwaitingReply, awaitingAgeLabel } from "@/lib/awaitingReply";
import AssignDropdown from "./components/AssignDropdown";
import MessageBubble, {
  type ConversationMessage,
} from "./components/MessageBubble";
import Composer from "./components/Composer";
import MatchOpsMobileStrip from "../MatchOpsMobileStrip";
import MetricsStrip from "./components/MetricsStrip";
import ContextPane from "./components/ContextPane";
import { colorForCity } from "@/lib/cityColors";
import { KNOWN_CITY_CODES, HIDDEN_CITY_CODES } from "@/lib/cityNormalization";

// ---------------- helpers ----------------
// The CRM data types (ThreadListRow / Message / ThreadDetail), bearerHeaders and markThreadRead
// moved to @/lib/crmConversation with the data layer (Phase 19 Step 2 B1) and are imported above.

function fullNameOf(t: ThreadListRow): string {
  if (t.player) {
    const first = t.player.first_name?.trim() ?? "";
    const last = t.player.last_name?.trim() ?? "";
    const full = `${first} ${last}`.trim();
    if (full) return full;
  }
  return t.phone_number;
}

function cityCodeForThread(t: ThreadListRow): string {
  const c = t.player?.preferable_city_normalized;
  return c && c.length > 0 ? c : UNKNOWN_CITY;
}

// Delegates to the shared, tested rule in src/lib/crmWindow (Phase 19 Step 0). A null detail
// means "nothing loaded yet" → not expired (the composer stays enabled until we know).
function computeWhatsAppExpired(detail: ThreadDetail | null): boolean {
  if (!detail) return false;
  return whatsappWindowExpired(detail.thread.channel, detail.latest_inbound_at, Date.now());
}

// ---------------- main ----------------

export default function CrmClient() {
  const { appUser } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();

  // --------- CRM data layer (Phase 19 Step 2 B1) ---------
  // threads, the open conversation, selection, counts, view, the loaders and onSent now live in
  // the provider mounted in match-ops/layout.tsx (so they survive navigation). CrmClient consumes
  // them here; its ~15 setThreads sites and the realtime subscription write through these setters.
  // Aliased so the body below is UNCHANGED: selectedThreadId → selectedId, selectThread →
  // setSelected. Selection is now provider state (OFF the URL); setFilters still owns ?view.
  const {
    threads, setThreads, threadsError, threadsLoading, setThreadsLoading,
    counts, operators,
    detail, setDetail, detailError, detailLoading, realtimeOk,
    selectedThreadId: selectedId, selectThread: setSelected,
    view, nowMs,
    loadThreads, loadDetail, loadOperators, onSent,
    dockThread, dockedThreadId,
  } = useCrmConversation();

  const setFilters = useCallback(
    (next: { view: StatusFilter }) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next.view === "open") params.delete("view");
      else params.set("view", next.view);
      const qs = params.toString();
      router.replace(qs ? `/match-ops/player-chats?${qs}` : "/match-ops/player-chats", {
        scroll: false,
      });
    },
    [router, searchParams],
  );

  // Client-side inbox filters (no refetch): search over player name, a city
  // set, and additive flags. The filter popover carries the cities + flags;
  // the active count shows on the filter button.
  const [search, setSearch] = useState("");
  const [cityFilter, setCityFilter] = useState<Set<string>>(new Set());
  const [flagStarred, setFlagStarred] = useState(false);
  const [flagAssigned, setFlagAssigned] = useState(false);
  const [flagMembers, setFlagMembers] = useState(false);
  const [contextHidden, setContextHidden] = useState(false);

  // The player-context pane (ContextPane) is shown by default beside a
  // selected thread; contextHidden (declared with the other redesign UI state
  // above) toggles it off. It is always hidden below 1260px via CSS.

  // Lock document scroll while /chats is mounted. iOS Safari standalone
  // PWA scrolls the document when the keyboard opens (to keep the focused
  // input visible) and does not restore scrollTop on dismiss. With the
  // document scroll axis disabled, iOS has nothing to scroll, and the
  // title bar + bottom nav stay anchored to the viewport. Inbox list and
  // conversation messages keep their own internal scroll containers.
  //
  // Note on the transient post-keyboard layout glitch: iOS standalone
  // PWA briefly holds a stale composited layer for the chat shell
  // after the on-screen keyboard dismisses. Multiple attempted
  // automatic nudges (visualViewport scrollTo, offsetHeight reflow,
  // documentElement transform toggle) all failed to invalidate the
  // stale layer — the only thing that reliably fixes it is a tab
  // navigation, which forces a full remount. The white background
  // mask in globals.css (html.app-shell-locked) ensures the glitch
  // shows white not beige, so the visual artifact is minimal, and
  // any tab switch self-heals it. Accepted as-is.
  useEffect(() => {
    document.documentElement.classList.add("app-shell-locked");
    document.body.classList.add("app-shell-locked");
    return () => {
      document.documentElement.classList.remove("app-shell-locked");
      document.body.classList.remove("app-shell-locked");
    };
  }, []);

  // The fetchers (loadThreads, scheduleReload, loadOperators, loadDetail,
  // refreshDetailForMediaInsert) moved to @/lib/crmConversation with the data layer (B1) and are
  // consumed via the destructure above. The effects that ORCHESTRATE them stay here.

  useEffect(() => {
    void loadOperators();
  }, [loadOperators]);

  // (Re)load the thread list whenever the view changes. The list is
  // filtered server-side per view, so switching Open/Mine/Starred/
  // Closed is a refetch. City filtering stays client-side (below) and
  // does not refetch. viewRef updates in the effect above this one, so
  // it is already current when loadThreads reads it.
  useEffect(() => {
    setThreadsLoading(true);
    void loadThreads();
  }, [view, loadThreads]);

  // iOS PWA home-screen badge. Writes the unread thread count to the
  // app icon every time `threads` updates — covers both fresh inbox
  // loads and optimistic mark-read patches. Idempotent with the SW
  // push handler's setAppBadge(); whichever writes last wins. No-op
  // on browsers without the Badging API (desktop Chrome, Safari < 16.4,
  // any non-installed PWA).
  useEffect(() => {
    if (typeof navigator === "undefined") return;
    const setBadge = (
      navigator as Navigator & {
        setAppBadge?: (n: number) => Promise<void>;
        clearAppBadge?: () => Promise<void>;
      }
    ).setAppBadge;
    const clearBadge = (
      navigator as Navigator & {
        setAppBadge?: (n: number) => Promise<void>;
        clearAppBadge?: () => Promise<void>;
      }
    ).clearAppBadge;
    if (typeof setBadge !== "function") return;
    const count = threads.reduce((n, t) => n + (t.is_unread ? 1 : 0), 0);
    if (count === 0) {
      clearBadge?.call(navigator).catch(() => {});
    } else {
      setBadge.call(navigator, count).catch(() => {});
    }
  }, [threads]);

  // Reload detail whenever the selection changes (or first mounts
  // with a threadId from the URL). Resetting detail to null
  // momentarily keeps the previous thread's messages from flashing.
  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    void loadDetail(selectedId);
    // Mark-read fire-and-forget. Optimistic local patch first so the
    // dot disappears immediately; server upsert follows. If the
    // server call fails, the next inbox refetch (realtime or manual
    // refresh) restores the true state. Display rule is also
    // assignment-aware on the server, so a non-assignee opening an
    // assigned thread won't suddenly see a phantom clear — the
    // optimistic patch sets is_unread = false locally, which is
    // exactly what the server would have computed for them anyway.
    setThreads((prev) =>
      prev.map((t) => (t.id === selectedId ? { ...t, is_unread: false } : t)),
    );
    void markThreadRead(selectedId);
  }, [selectedId, loadDetail]);

  // The realtime subscription moved to the provider (@/lib/crmConversation) in B2 — one channel,
  // mounted in the persistent layout so messages keep arriving while navigated away. Its five
  // handlers write through the provider's setters, unchanged.

  // --------- derived list ---------
  // The server already filtered by the active view. Here we only apply
  // the client-side city filter (no refetch on city toggle) and, in the
  // Starred view, drop rows the viewer just unstarred so removal is
  // instant.
  const visibleThreads = useMemo(() => {
    const arr = [...threads].sort(
      (a, b) => Date.parse(b.last_message_at) - Date.parse(a.last_message_at),
    );
    return arr.filter((t) => {
      if (view === "starred" && !t.is_follow_up) return false;
      // The server already scopes the awaiting view, but realtime
      // patches can drop a fresh row in — re-apply the full refined rule
      // here so a just-answered, acknowledged, or dismissed thread leaves
      // the view immediately.
      if (view === "awaiting" && !isAwaitingReply(t)) return false;
      return true;
    });
  }, [threads, view]);

  const appUserId = appUser?.id ?? null;
  // Phase 19 Step 1: SEND is its own right. Courtesy-grey only — the /api/crm/send route is the
  // real gate (403s without it); this just disables the composer with a reason so the operator
  // never types into a box the server will reject.
  const canSendMessages = appUser?.can_send_messages === true;

  // Client-side filters over the server-scoped view (no refetch): city set,
  // additive flags, and a name/preview search. `filtersActive` distinguishes
  // "you filtered to nothing" (→ filter-empty message) from "there's genuinely
  // nothing" (→ all-caught-up card).
  const filtersActive =
    cityFilter.size > 0 ||
    flagStarred ||
    flagAssigned ||
    flagMembers ||
    search.trim().length > 0;

  const filteredThreads = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return visibleThreads.filter((t) => {
      if (cityFilter.size > 0 && !cityFilter.has(cityCodeForThread(t))) return false;
      if (flagStarred && !t.is_follow_up) return false;
      if (flagAssigned && t.assigned_to_user_id !== appUserId) return false;
      if (flagMembers && t.player?.is_member !== true) return false;
      if (needle) {
        const hay = [fullNameOf(t), t.phone_number, t.last_message_preview ?? ""]
          .join(" ")
          .toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [visibleThreads, cityFilter, flagStarred, flagAssigned, flagMembers, search, appUserId]);

  const isAwaiting = (t: ThreadListRow) => isAwaitingReply(t);

  // Two groups (mockup playerchats-v1): "Waiting on a reply" (amber — the
  // customer spoke last and needs an answer, oldest on top) and "Answered —
  // nothing owed" (everything else, including closing acknowledgments — all
  // genuinely nothing-owed). Closed / other views render one ungrouped list.
  const threadGroups = useMemo<
    { key: string; label: string | null; tone: "await" | "quiet"; rows: ThreadListRow[] }[]
  >(() => {
    const byOldest = (a: ThreadListRow, b: ThreadListRow) =>
      Date.parse(a.last_message_at) - Date.parse(b.last_message_at);
    const byNewest = (a: ThreadListRow, b: ThreadListRow) =>
      Date.parse(b.last_message_at) - Date.parse(a.last_message_at);
    if (view === "open" || view === "mine") {
      const waiting = filteredThreads.filter(isAwaiting).sort(byOldest);
      const answered = filteredThreads.filter((t) => !isAwaiting(t)).sort(byNewest);
      const groups: { key: string; label: string | null; tone: "await" | "quiet"; rows: ThreadListRow[] }[] = [];
      if (waiting.length > 0)
        groups.push({ key: "waiting", label: `Waiting on a reply · ${waiting.length}`, tone: "await", rows: waiting });
      if (answered.length > 0)
        groups.push({ key: "answered", label: "Answered — nothing owed", tone: "quiet", rows: answered });
      return groups;
    }
    return filteredThreads.length > 0
      ? [{ key: view, label: null, tone: "quiet", rows: [...filteredThreads].sort(byNewest) }]
      : [];
  }, [filteredThreads, view]);

  // Stability guard for clicks. Rows move between the Awaiting and
  // Answered groups as realtime events land; if a row relocates in the
  // window between pointer-down and pointer-up, the browser's click
  // never completes and the tap appears to do nothing. While the
  // pointer is held down over the list we render a frozen snapshot of
  // the groups so nothing reorders under the finger; the live groups
  // resume (and reconcile any changes that arrived meanwhile) on
  // release. Selection/unread still update live — only row ORDER is
  // pinned, keyed by thread id.
  const [frozenGroups, setFrozenGroups] = useState<
    typeof threadGroups | null
  >(null);
  const renderGroups = frozenGroups ?? threadGroups;
  const freezeGroups = useCallback(() => {
    setFrozenGroups((prev) => prev ?? threadGroups);
  }, [threadGroups]);
  const thawGroups = useCallback(() => setFrozenGroups(null), []);

  const selectedThread =
    visibleThreads.find((t) => t.id === selectedId) ??
    threads.find((t) => t.id === selectedId) ??
    null;

  // --------- mutations ---------
  const onAssign = useCallback(
    async (threadId: string, userId: string | null) => {
      const headers = await bearerHeaders();
      if (!headers) return;
      try {
        const res = await fetch(`/api/crm/threads/${threadId}/assign`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ user_id: userId }),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error(j.error || `HTTP ${res.status}`);
        }
        const j = (await res.json()) as {
          thread: ThreadListRow;
          assignee: Assignee | null;
        };
        setThreads((prev) =>
          prev.map((x) =>
            x.id === threadId
              ? {
                  ...x,
                  assigned_to_user_id: j.thread.assigned_to_user_id,
                  assigned_at: j.thread.assigned_at,
                  assignee: j.assignee,
                }
              : x,
          ),
        );
        setDetail((prev) =>
          prev && prev.thread.id === threadId
            ? {
                ...prev,
                thread: {
                  ...prev.thread,
                  assigned_to_user_id: j.thread.assigned_to_user_id,
                  assigned_at: j.thread.assigned_at,
                },
                assignee: j.assignee,
              }
            : prev,
        );
        // Assignment changes the Mine count and Mine-view membership.
        // Refetch to reconcile counts and (if viewing Mine) drop/add
        // the row.
        void loadThreads();
      } catch (err) {
        console.error("[crm] assign failed", err);
      }
    },
    [loadThreads],
  );

  // onSent moved to the provider (setDetail + setThreads on an operator's own send); consumed via
  // the destructure above and handed to Composer unchanged.

  // Follow-up star toggle. `desired` is passed from the call site (the
  // row/header knows the current state), so it's an explicit set, not a
  // blind toggle — matches the idempotent endpoint. Optimistic: patch
  // both the list row and the open detail immediately, revert on failure.
  const onToggleFollowUp = useCallback(
    async (threadId: string, desired: boolean) => {
      const patch = (value: boolean) => {
        setThreads((prev) =>
          prev.map((t) =>
            t.id === threadId ? { ...t, is_follow_up: value } : t,
          ),
        );
        setDetail((prev) =>
          prev && prev.thread.id === threadId
            ? { ...prev, thread: { ...prev.thread, is_follow_up: value } }
            : prev,
        );
      };
      patch(desired);
      const headers = await bearerHeaders();
      if (!headers) {
        patch(!desired); // no session — undo the optimistic flip
        return;
      }
      try {
        const res = await fetch(`/api/crm/threads/${threadId}/follow-up`, {
          method: "POST",
          headers,
          body: JSON.stringify({ follow_up: desired }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        // Starred count (and the Starred view) depend on this flag.
        // Refetch to keep the count and index in sync.
        void loadThreads();
      } catch (err) {
        console.error("[crm] follow-up toggle failed", err);
        patch(!desired); // revert
      }
    },
    [loadThreads],
  );

  // ----- "no reply needed" dismiss / reactivate -----
  // dismiss  → "Done · no reply needed": moves an awaiting thread into the
  //            muted Wrapping-up group without replying or closing.
  // reactivate → "Reply anyway": clears the dismissal so the thread is
  //            governed by direction + the ack heuristic again.
  // Optimistic like the star: patch local state first (the realtime echo
  // for a new column can lag Supabase's schema cache), reconcile on
  // failure, and refetch to keep the awaiting count in sync.
  const onSetNoReply = useCallback(
    async (threadId: string, action: "dismiss" | "reactivate") => {
      const value = action === "dismiss" ? new Date().toISOString() : null;
      const patch = (v: string | null) => {
        setThreads((prev) =>
          prev.map((t) =>
            t.id === threadId ? { ...t, no_reply_needed_at: v } : t,
          ),
        );
        setDetail((prev) =>
          prev && prev.thread.id === threadId
            ? { ...prev, thread: { ...prev.thread, no_reply_needed_at: v } }
            : prev,
        );
      };
      const prevValue =
        threads.find((t) => t.id === threadId)?.no_reply_needed_at ?? null;
      patch(value);
      const headers = await bearerHeaders();
      if (!headers) {
        patch(prevValue);
        return;
      }
      try {
        const res = await fetch(`/api/crm/threads/${threadId}/no-reply`, {
          method: "POST",
          headers,
          body: JSON.stringify({ action }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        // The Awaiting count / view membership changed — resync.
        void loadThreads();
      } catch (err) {
        console.error("[crm] no-reply toggle failed", err);
        patch(prevValue); // revert
      }
    },
    [threads, loadThreads],
  );

  // ----- bulk selection (Open view, admins) -----
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // Selection only applies to the Open view; clear it when leaving so a
  // stale set can't carry into Closed/Starred/Mine.
  useEffect(() => {
    if (view !== "open") setSelectedIds(new Set());
  }, [view]);
  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  // Undo toast shown for a few seconds after a close (single or bulk),
  // so a misclick can be reverted without hunting through the Closed
  // view. A new close replaces the toast (only the most recent batch is
  // undoable).
  const [closeToast, setCloseToast] = useState<{ threadIds: string[] } | null>(
    null,
  );
  const closeToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (closeToastTimer.current) clearTimeout(closeToastTimer.current);
    },
    [],
  );
  const showCloseToast = useCallback((threadIds: string[]) => {
    if (threadIds.length === 0) return;
    if (closeToastTimer.current) clearTimeout(closeToastTimer.current);
    setCloseToast({ threadIds });
    closeToastTimer.current = setTimeout(() => setCloseToast(null), 5000);
  }, []);

  // Close / reopen the selected conversation (admin-only; the button is
  // hidden for non-admins and the API rejects them too). Optimistic:
  // flip the local status so the header button and inbox reflect it
  // immediately, then refetch in `finally` to reconcile view membership
  // and counts (also self-heals if the request failed). Close pops the
  // Undo toast; there is no confirm step so closing stays fast.
  const onSetThreadStatus = useCallback(
    async (threadId: string, action: "close" | "reopen") => {
      const nextStatus = action === "close" ? "closed" : "open";
      setThreads((prev) =>
        prev.map((t) =>
          t.id === threadId ? { ...t, status: nextStatus } : t,
        ),
      );
      setDetail((prev) =>
        prev && prev.thread.id === threadId
          ? { ...prev, thread: { ...prev.thread, status: nextStatus } }
          : prev,
      );
      if (action === "close") showCloseToast([threadId]);
      const headers = await bearerHeaders();
      if (!headers) {
        void loadThreads();
        return;
      }
      try {
        const res = await fetch(`/api/crm/threads/${threadId}/status`, {
          method: "POST",
          headers,
          body: JSON.stringify({ action }),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error(j.error || `HTTP ${res.status}`);
        }
      } catch (err) {
        console.error("[crm] status change failed", err);
      } finally {
        void loadThreads();
      }
    },
    [loadThreads, showCloseToast],
  );

  // Bulk close the selected threads in one request, then offer undo.
  // Optimistic: flip the selected rows to closed and clear the
  // selection; the refetch reconciles membership + counts.
  const onBulkClose = useCallback(async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    setThreads((prev) =>
      prev.map((t) => (idSet.has(t.id) ? { ...t, status: "closed" } : t)),
    );
    clearSelection();
    const headers = await bearerHeaders();
    if (!headers) {
      void loadThreads();
      return;
    }
    try {
      const res = await fetch(`/api/crm/threads/bulk-status`, {
        method: "POST",
        headers,
        body: JSON.stringify({ action: "close", thread_ids: ids }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      const j = (await res.json()) as { closed_ids?: string[] };
      showCloseToast(j.closed_ids?.length ? j.closed_ids : ids);
    } catch (err) {
      console.error("[crm] bulk close failed", err);
    } finally {
      void loadThreads();
    }
  }, [selectedIds, clearSelection, loadThreads, showCloseToast]);

  // Undo a close batch (single or bulk): reopen the threads and drop
  // their close audit rows via the bulk endpoint (handles one id or
  // many). Dismisses the toast immediately.
  const onUndoClose = useCallback(
    async (threadIds: string[]) => {
      if (threadIds.length === 0) return;
      if (closeToastTimer.current) clearTimeout(closeToastTimer.current);
      setCloseToast(null);
      const idSet = new Set(threadIds);
      setThreads((prev) =>
        prev.map((t) => (idSet.has(t.id) ? { ...t, status: "open" } : t)),
      );
      setDetail((prev) =>
        prev && idSet.has(prev.thread.id)
          ? { ...prev, thread: { ...prev.thread, status: "open" } }
          : prev,
      );
      const headers = await bearerHeaders();
      if (!headers) {
        void loadThreads();
        return;
      }
      try {
        const res = await fetch(`/api/crm/threads/bulk-status`, {
          method: "POST",
          headers,
          body: JSON.stringify({ action: "undo_close", thread_ids: threadIds }),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error(j.error || `HTTP ${res.status}`);
        }
      } catch (err) {
        console.error("[crm] undo close failed", err);
      } finally {
        void loadThreads();
      }
    },
    [loadThreads],
  );

  const whatsappExpired = computeWhatsAppExpired(detail);
  // Chat operators (admins OR can_access_chats) run the full ticket
  // workflow — close/reopen and bulk-close. Mirrors the status +
  // bulk-status API gates; canned-response editing stays admin-only.
  const canManageStatus =
    appUser?.is_admin === true || appUser?.can_access_chats === true;
  // Bulk-select checkboxes only make sense in the Open view for
  // operators who can act on the selection.
  const bulkSelectable = canManageStatus && view === "open";
  // Select-all operates on the current filtered page only (visibleThreads
  // is already city-filtered and server-capped) — never a phantom
  // "select 200+ across pages".
  const visibleIds = useMemo(
    () => visibleThreads.map((t) => t.id),
    [visibleThreads],
  );
  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
  const someVisibleSelected = visibleIds.some((id) => selectedIds.has(id));
  const toggleSelectAllVisible = useCallback(() => {
    setSelectedIds((prev) => {
      const everySelected =
        visibleIds.length > 0 && visibleIds.every((id) => prev.has(id));
      const next = new Set(prev);
      if (everySelected) visibleIds.forEach((id) => next.delete(id));
      else visibleIds.forEach((id) => next.add(id));
      return next;
    });
  }, [visibleIds]);

  // Mobile flow rules:
  //   no selectedId             → inbox full-screen
  //   selectedId on mobile      → conversation full-screen + back arrow
  //   selectedId on desktop     → both panes side-by-side
  // Implemented via Tailwind responsive `hidden lg:flex` rather than
  // JS branching so the layout doesn't reflow on viewport change.
  const showInboxMobile = !selectedId;
  const showConversationMobile = !!selectedId;

  const liveLabel =
    realtimeOk == null ? "Connecting" : realtimeOk ? "Live" : "Offline";
  const segments: { key: StatusFilter; label: string; n: number }[] = [
    { key: "open", label: "Open", n: counts.open },
    { key: "mine", label: "Mine", n: counts.mine },
    { key: "closed", label: "Closed", n: counts.closed },
  ];
  // All-caught-up: default view, no user filter, and genuinely zero open
  // threads (counts.open is the true server count, not a capped list). Distinct
  // from a filter that matched nothing (filtersActive) — those get their own
  // message so the best outcome never reads as a broken filter.
  const showCaughtUp =
    view === "open" && !filtersActive && counts.open === 0 && !threadsLoading;
  const listEmpty = renderGroups.length === 0;

  return (
    // The rail is owned by the section layout (fixed, full-bleed). We only leave
    // room for it on desktop via --mo-rail-w, which the layout sets.
    <div className="flex min-h-0 min-w-0 flex-1 lg:pl-[var(--mo-rail-w)]" style={{ background: "#f8faf9" }}>
      {/* Right column: metrics strip over the three panes */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Desktop-only: the mobile console is a clean list; the awaiting
            signal on a phone rides the section strip badge + per-row tag. */}
        <div className="hidden min-[900px]:block">
          <MetricsStrip />
        </div>

        <div className="flex min-h-0 min-w-0 flex-1">
          {/* ---- INBOX ---- */}
          <aside
            className={`min-w-0 flex-col border-r lg:flex lg:w-[400px] lg:shrink-0 ${
              showInboxMobile ? "flex flex-1" : "hidden lg:flex"
            }`}
            style={{ background: "#f8faf9", borderColor: "#e6ebe8" }}
          >
            {/* Mobile-only section nav — desktop rail is hidden below 900px. */}
            <MatchOpsMobileStrip />

            {/* header */}
            <div className="flex flex-none items-center gap-2.5 px-4 pt-3.5">
              <h1 className="text-[19px] font-[760] tracking-[-0.02em]" style={{ color: "#12241d" }}>
                Player Chats
              </h1>
              <span
                className="inline-flex items-center gap-1.5 rounded-full border px-2 py-[3px] pl-[7px] text-[11px] font-bold"
                style={{ color: "#12704a", background: "#e0f2e7", borderColor: "#c9e8d8" }}
              >
                <i className="h-1.5 w-1.5 rounded-full" style={{ background: realtimeOk === false ? "#e2502b" : "#35c77f" }} />
                {liveLabel}
              </span>
              <span className="ml-auto flex items-center gap-0.5">
                {/* Notification toggle — renders at EVERY width. It used to sit in a
                    `hidden … min-[900px]:flex` footer (4f7c3fd, which was stripping KEYBOARD
                    affordances on touch and swept this along), so on a phone there was no way to
                    subscribe at all — the one place push matters most. The keyboard hints stay
                    hidden; that part of 4f7c3fd was right. */}
                <EnablePushNotificationsButton />
                <button
                  type="button"
                  onClick={() => void loadThreads()}
                  title="Refresh"
                  aria-label="Refresh"
                  className="flex h-11 w-11 items-center justify-center rounded-[10px] transition hover:bg-white/85 min-[900px]:h-[31px] min-[900px]:w-[31px]"
                  style={{ color: "#5c7267" }}
                >
                  <RotateCcw aria-hidden size={16} strokeWidth={1.9} />
                </button>
                <button
                  type="button"
                  onClick={() => setContextHidden((h) => !h)}
                  title={contextHidden ? "Show player details" : "Hide player details"}
                  aria-label={contextHidden ? "Show player details" : "Hide player details"}
                  className="hidden h-[31px] w-[31px] items-center justify-center rounded-[10px] transition hover:bg-white/85 min-[1260px]:flex"
                  style={{ color: contextHidden ? "#93a49b" : "#12704a" }}
                >
                  <Info aria-hidden size={16} strokeWidth={1.9} />
                </button>
              </span>
            </div>

            {/* search + filter popover */}
            <SearchAndFilter
              search={search}
              onSearch={setSearch}
              cityFilter={cityFilter}
              onToggleCity={(c) =>
                setCityFilter((prev) => {
                  const next = new Set(prev);
                  if (next.has(c)) next.delete(c);
                  else next.add(c);
                  return next;
                })
              }
              flagStarred={flagStarred}
              flagAssigned={flagAssigned}
              flagMembers={flagMembers}
              onToggleFlag={(f) => {
                if (f === "starred") setFlagStarred((v) => !v);
                if (f === "assigned") setFlagAssigned((v) => !v);
                if (f === "members") setFlagMembers((v) => !v);
              }}
            />

            {/* segmented control */}
            <div className="mx-4 mb-3 mt-2.5 flex flex-none gap-0.5 rounded-[11px] p-[3px]" style={{ background: "rgba(0,0,0,.045)" }}>
              {segments.map((s) => {
                const on = view === s.key;
                return (
                  <button
                    key={s.key}
                    type="button"
                    onClick={() => setFilters({ view: s.key })}
                    className="flex h-11 min-[900px]:h-[30px] flex-1 items-center justify-center gap-1.5 rounded-[8px] text-[12.5px] font-[650] transition"
                    style={on ? { background: "#ffffff", color: "#0f3d2e", fontWeight: 730, boxShadow: "0 1px 2px rgba(7,42,32,.09)" } : { color: "#5c7267" }}
                  >
                    {s.label}
                    <span className="text-[11px] font-bold tabular-nums" style={{ color: on ? "#3d9b73" : "#93a49b" }}>{s.n}</span>
                  </button>
                );
              })}
            </div>

            {/* list / states */}
            <div
              className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden px-2 pb-3.5"
              onPointerDown={freezeGroups}
              onPointerUp={thawGroups}
              onPointerCancel={thawGroups}
              onPointerLeave={thawGroups}
            >
              {bulkSelectable && renderGroups.length > 0 && (
                // Bulk close is a desktop power-tool (tiny checkboxes); hidden
                // on touch where 20px targets fail the 44px minimum.
                <div className="hidden min-[900px]:block">
                  <BulkSelectBar
                    selectedCount={selectedIds.size}
                    allSelected={allVisibleSelected}
                    someSelected={someVisibleSelected}
                    onToggleAll={toggleSelectAllVisible}
                    onClear={clearSelection}
                    onCloseSelected={() => void onBulkClose()}
                  />
                </div>
              )}
              {threadsError && (
                <div className="m-2 rounded-lg border px-3 py-2 text-xs" style={{ borderColor: "#e3c369", background: "#fdf1d0", color: "#8a6300" }}>
                  {threadsError}
                </div>
              )}
              {threadsLoading && listEmpty && <InboxSkeleton />}
              {showCaughtUp && (
                <AllCaughtUpCard
                  onReviewClosed={() => setFilters({ view: "closed" })}
                  closedCount={counts.closed}
                />
              )}
              {!threadsLoading && !showCaughtUp && listEmpty && !threadsError && (
                <div className="px-4 py-9 text-center text-[12.5px]" style={{ color: "#93a49b" }}>
                  {filtersActive ? (
                    <>
                      No conversations match those filters.
                      <br />
                      <button
                        type="button"
                        onClick={() => {
                          setCityFilter(new Set());
                          setFlagStarred(false);
                          setFlagAssigned(false);
                          setFlagMembers(false);
                          setSearch("");
                        }}
                        className="mt-3 rounded-full border px-3 py-1 text-[12px] font-[650]"
                        style={{ borderColor: "#e6ebe8", background: "#ffffff", color: "#3f544a" }}
                      >
                        Clear filters
                      </button>
                    </>
                  ) : view === "closed" ? (
                    "No closed conversations."
                  ) : (
                    "Nothing here."
                  )}
                </div>
              )}
              {!showCaughtUp &&
                renderGroups.map((g) => (
                  <div key={g.key} className="mb-1">
                    {g.label && (
                      <div className="flex items-center gap-2 px-2 pb-[7px] pt-3">
                        <span className="text-[10px] font-extrabold uppercase tracking-[0.12em]" style={{ color: g.tone === "await" ? "#8a6300" : "#93a49b" }}>
                          {g.label}
                        </span>
                        <span className="h-px flex-1" style={{ background: "#e6ebe8" }} />
                      </div>
                    )}
                    {g.rows.map((t) => (
                      <MistInboxRow
                        key={t.id}
                        thread={t}
                        nowMs={nowMs}
                        active={t.id === selectedId}
                        mine={t.assigned_to_user_id === appUserId}
                        onSelect={() => setSelected(t.id)}
                        onToggleFollowUp={() => onToggleFollowUp(t.id, !t.is_follow_up)}
                      />
                    ))}
                  </div>
                ))}
            </div>

          </aside>

          {/* ---- THREAD ---- */}
          <section
            className={`min-w-0 flex-col lg:static lg:z-auto lg:flex lg:flex-1 ${showConversationMobile ? "fixed inset-0 z-40 flex" : "hidden lg:flex"}`}
            style={{ background: "#ffffff" }}
          >
            {!selectedId ? (
              <EmptyConversation />
            ) : !selectedThread && !detail ? (
              <div className="flex flex-1 items-center justify-center text-xs" style={{ color: "#93a49b" }}>
                Loading conversation…
              </div>
            ) : (
              <Conversation
                selectedId={selectedId}
                detail={detail}
                error={detailError}
                loading={detailLoading}
                appUserId={appUserId}
                canSendMessages={canSendMessages}
                operators={operators}
                onAssign={(userId) => onAssign(selectedId, userId)}
                onSent={onSent}
                onBack={() => setSelected(null)}
                onOpenContext={() => setContextHidden(false)}
                onToggleContext={() => setContextHidden((h) => !h)}
                contextOpen={!contextHidden}
                isMember={selectedThread?.player?.is_member === true}
                isFollowUp={selectedThread?.is_follow_up ?? false}
                onToggleFollowUp={() =>
                  onToggleFollowUp(selectedId, !(selectedThread?.is_follow_up ?? false))
                }
                threadStatus={detail?.thread.status ?? selectedThread?.status ?? "open"}
                canManageStatus={canManageStatus}
                onSetStatus={(action) => onSetThreadStatus(selectedId, action)}
                whatsappWindowExpired={whatsappExpired}
                onDock={() => dockThread(selectedId)}
                isDocked={dockedThreadId === selectedId}
              />
            )}
          </section>

          {/* ---- PLAYER CONTEXT (292px, hidden < 1260px + toggle) ---- */}
          {selectedThread && !contextHidden && <ContextPane threadId={selectedThread.id} />}
        </div>
      </div>

      {closeToast && (
        <CloseUndoToast
          count={closeToast.threadIds.length}
          onUndo={() => onUndoClose(closeToast.threadIds)}
          onDismiss={() => setCloseToast(null)}
        />
      )}
    </div>
  );
}

// ============================================================
// Bulk-select action bar — sits at the top of the Open inbox for
// admins. Select-all toggles the current page; when 1+ are selected
// it shows the count plus Close selected / Clear selection.
// ============================================================
function BulkSelectBar({
  selectedCount,
  allSelected,
  someSelected,
  onToggleAll,
  onClear,
  onCloseSelected,
}: {
  selectedCount: number;
  allSelected: boolean;
  someSelected: boolean;
  onToggleAll: () => void;
  onClear: () => void;
  onCloseSelected: () => void;
}) {
  return (
    <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-cream-line bg-cream px-3 py-1.5 sm:px-4">
      <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-deep-green/70">
        <input
          type="checkbox"
          aria-label="Select all conversations on this page"
          checked={allSelected}
          ref={(el) => {
            if (el) el.indeterminate = someSelected && !allSelected;
          }}
          onChange={onToggleAll}
          className="h-4 w-4 rounded border-deep-green/30 accent-deep-green focus:ring-deep-green/40"
        />
        {selectedCount > 0 ? `${selectedCount} selected` : "Select all"}
      </label>
      {selectedCount > 0 && (
        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={onClear}
            className="rounded-full px-2 py-1 text-xs font-medium text-deep-green/60 transition hover:bg-cream-soft hover:text-deep-green"
          >
            Clear selection
          </button>
          <button
            type="button"
            onClick={onCloseSelected}
            className="inline-flex items-center gap-1 rounded-full bg-deep-green px-3 py-1 text-xs font-bold text-cream transition hover:bg-deep-green-soft"
          >
            <CircleCheck aria-hidden className="h-3.5 w-3.5" strokeWidth={2} />
            Close selected
          </button>
        </div>
      )}
    </div>
  );
}

// ============================================================
// Undo toast — appears for ~5s after a close (timer lives in the
// parent). Reverts the status and removes the close audit row(s).
// Handles single and bulk closes via the count.
// ============================================================
function CloseUndoToast({
  count,
  onUndo,
  onDismiss,
}: {
  count: number;
  onUndo: () => void;
  onDismiss: () => void;
}) {
  const label =
    count === 1 ? "Thread closed" : `${count} threads closed`;
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4"
      style={{ marginBottom: "var(--safe-area-bottom)" }}
    >
      <div className="pointer-events-auto flex items-center gap-3 rounded-full border border-deep-green-soft bg-deep-green px-4 py-2 text-sm text-cream shadow-lg shadow-deep-green/30">
        <span className="font-medium">{label}</span>
        <button
          type="button"
          onClick={onUndo}
          className="rounded-full px-2 py-0.5 text-xs font-bold text-mint transition hover:bg-deep-green-soft"
        >
          Undo
        </button>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="rounded-full px-1 text-cream/60 transition hover:text-cream"
        >
          ✕
        </button>
      </div>
    </div>
  );
}


// ============================================================
// Search box + filter popover (cities + additive flags)
// ============================================================
const ALL_CITY_CODES: readonly string[] = [
  ...KNOWN_CITY_CODES.filter((c) => !HIDDEN_CITY_CODES.has(c)),
  UNKNOWN_CITY,
];

function SearchAndFilter({
  search,
  onSearch,
  cityFilter,
  onToggleCity,
  flagStarred,
  flagAssigned,
  flagMembers,
  onToggleFlag,
}: {
  search: string;
  onSearch: (s: string) => void;
  cityFilter: Set<string>;
  onToggleCity: (c: string) => void;
  flagStarred: boolean;
  flagAssigned: boolean;
  flagMembers: boolean;
  onToggleFlag: (f: "starred" | "assigned" | "members") => void;
}) {
  const searchRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "/") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
      searchRef.current?.focus();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const flagsOn = [flagStarred, flagAssigned, flagMembers].filter(Boolean).length;
  const filterCount = cityFilter.size + flagsOn;
  const label =
    filterCount === 0
      ? "Filter"
      : cityFilter.size === 1 && filterCount === 1
        ? [...cityFilter][0]
        : `${filterCount} filters`;

  const flagRow: { key: "starred" | "assigned" | "members"; label: string; on: boolean }[] = [
    { key: "starred", label: "Starred", on: flagStarred },
    { key: "assigned", label: "Assigned to me", on: flagAssigned },
    { key: "members", label: "Members only", on: flagMembers },
  ];

  return (
    <div className="relative mt-2.5 flex flex-none items-center gap-2 px-4" ref={wrapRef}>
      <div className="relative flex-1">
        <svg viewBox="0 0 24 24" className="pointer-events-none absolute left-[11px] top-1/2 h-[15px] w-[15px] -translate-y-1/2" fill="none" stroke="#9aa8a1" strokeLinecap="round" strokeWidth={2} aria-hidden>
          <circle cx="11" cy="11" r="6.5" />
          <path d="M16 16l4.5 4.5" />
        </svg>
        <input
          ref={searchRef}
          data-testid="crm-search"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Search players…"
          className="h-9 w-full rounded-[11px] border pl-[33px] pr-[34px] text-[13px] outline-none transition focus:border-[#35c77f] focus:shadow-[0_0_0_3px_rgba(53,199,127,.15)]"
          style={{ background: "#ffffff", borderColor: "#e6ebe8", color: "#12241d" }}
        />
        <kbd className="pointer-events-none absolute right-[9px] top-1/2 hidden -translate-y-1/2 rounded-[5px] border px-[5px] py-px text-[10.5px] font-bold min-[900px]:block" style={{ color: "#a4b0aa", background: "#eef3f0", borderColor: "#e2eae5" }}>/</kbd>
      </div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-9 flex-none items-center gap-1.5 rounded-[11px] border px-[11px] text-[12.5px] font-[650] transition"
        style={filterCount > 0 ? { borderColor: "#0d3b2e", background: "#0d3b2e", color: "#eafaf1" } : { borderColor: "#e6ebe8", background: "#ffffff", color: "#3f544a" }}
      >
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} aria-hidden>
          <path d="M3 5h18" /><path d="M6.5 12h11" /><path d="M10 19h4" />
        </svg>
        {label}
        {filterCount > 0 && (
          <span className="rounded-full px-[5px] text-[10.5px] font-extrabold" style={{ background: "#35c77f", color: "#062a1e" }}>{filterCount}</span>
        )}
      </button>

      {open && (
        // stopPropagation so a click inside the popover never reaches the
        // document mousedown listener that closes it (item 7).
        <div
          onMouseDown={(e) => e.stopPropagation()}
          className="absolute right-4 top-[42px] z-20 w-[274px] rounded-[14px] border p-[11px] shadow-[0_2px_5px_rgba(7,42,32,.07),0_22px_44px_-24px_rgba(7,42,32,.55)]"
          style={{ background: "#ffffff", borderColor: "#e6ebe8" }}
        >
          <div className="mb-2 px-0.5 text-[9.5px] font-extrabold uppercase tracking-[0.13em]" style={{ color: "#93a49b" }}>City</div>
          <div className="flex flex-wrap gap-[5px]">
            {ALL_CITY_CODES.map((code) => {
              const on = cityFilter.has(code);
              return (
                <button key={code} type="button" onClick={() => onToggleCity(code)}
                  className="flex h-9 min-[900px]:h-[27px] items-center gap-[5px] rounded-full border px-[10px] text-[11.5px] font-bold tracking-[0.02em] transition"
                  style={on ? { background: "#0d3b2e", borderColor: "#0d3b2e", color: "#eafaf1" } : { background: "#ffffff", borderColor: "#e6ebe8", color: "#5c7267" }}>
                  {code}{on && <span className="-mr-0.5 text-[13px] leading-none opacity-75">×</span>}
                </button>
              );
            })}
          </div>
          <div className="mb-2 mt-3 px-0.5 text-[9.5px] font-extrabold uppercase tracking-[0.13em]" style={{ color: "#93a49b" }}>Only show</div>
          <div className="flex flex-wrap gap-[5px]">
            {flagRow.map((f) => (
              <button key={f.key} type="button" onClick={() => onToggleFlag(f.key)}
                className="flex h-9 min-[900px]:h-[27px] items-center gap-[5px] rounded-full border px-[10px] text-[11.5px] font-bold tracking-[0.02em] transition"
                style={f.on ? { background: "#0d3b2e", borderColor: "#0d3b2e", color: "#eafaf1" } : { background: "#ffffff", borderColor: "#e6ebe8", color: "#5c7267" }}>
                {f.label}{f.on && <span className="-mr-0.5 text-[13px] leading-none opacity-75">×</span>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// Inbox row (Mist) — mockup playerchats-v1
// ============================================================
function MistInboxRow({
  thread,
  nowMs,
  active,
  mine,
  onSelect,
  onToggleFollowUp,
}: {
  thread: ThreadListRow;
  nowMs: number;
  active: boolean;
  mine: boolean;
  onSelect: () => void;
  onToggleFollowUp: () => void;
}) {
  const name = fullNameOf(thread);
  const cc = cityCodeForThread(thread);
  const col = colorForCity(cc);
  const initials =
    (name.trim()[0] ?? "?").toUpperCase() +
    (name.trim().split(/\s+/)[1]?.[0]?.toUpperCase() ?? "");
  const waiting = isAwaitingReply(thread);
  const ago = awaitingAgeLabel(thread.last_message_at, nowMs);
  const inbound = thread.last_message_direction === "inbound";
  const preview = thread.last_message_preview ?? "";
  const speaker = inbound ? name.split(/\s+/)[0] || "Player" : "MatchDay";

  return (
    <button
      type="button"
      onClick={onSelect}
      data-testid="crm-thread-row"
      data-thread-id={thread.id}
      data-unread={thread.is_unread ? 1 : 0}
      data-waiting={waiting ? 1 : 0}
      style={{
        touchAction: "manipulation",
        ...(active
          ? { background: "#ffffff", borderColor: "#e2eae5", boxShadow: "0 1px 2px rgba(7,42,32,.05), 0 14px 30px -22px rgba(7,42,32,.5)" }
          : waiting
            ? { background: "rgba(253,241,208,.5)", borderColor: "transparent" }
            : { borderColor: "transparent" }),
      }}
      className={`relative mt-px flex w-full items-start gap-2.5 rounded-[13px] border p-[10px_11px] text-left transition ${active ? "" : "hover:bg-white/80"}`}
    >
      {(active || waiting) && (
        <span aria-hidden className="absolute left-0 top-[11px] bottom-[11px] w-[3px] rounded-r-[3px]" style={{ background: active ? "#35c77f" : "#e3c369" }} />
      )}
      <span className="relative mt-px flex h-[34px] w-[34px] flex-none items-center justify-center rounded-[11px] text-[9.5px] font-extrabold" style={{ background: `${col}22`, color: col }}>
        {initials || "?"}
        {thread.is_unread && (
          <span className="absolute -right-0.5 -top-0.5 h-[9px] w-[9px] rounded-full" style={{ background: "#35c77f", boxShadow: "0 0 0 2px #f8faf9" }} />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-1.5">
          <span data-testid="crm-thread-name" className={`min-w-0 flex-1 truncate text-[13.5px] tracking-[-0.008em] ${thread.is_unread ? "font-[760]" : "font-[660]"}`} style={{ color: "#12241d" }}>{name}</span>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onToggleFollowUp(); }}
            aria-label={thread.is_follow_up ? "Unstar" : "Star"}
            className="hidden flex-none min-[900px]:block"
            style={{ color: thread.is_follow_up ? "#e0a500" : "#c9d2cd" }}
          >
            <Star aria-hidden size={12} fill={thread.is_follow_up ? "currentColor" : "none"} />
          </button>
          <span className="flex-none text-[11px] font-[650]" style={{ color: waiting ? "#8a6300" : "#9aa8a1" }}>{ago}</span>
        </span>
        <span className="mt-0.5 flex items-center gap-1.5 text-[11.5px] font-[550]" style={{ color: "#6d7b74" }}>
          <span>{cc}</span>
          <span aria-hidden className="inline-block h-[3px] w-[3px] rounded-full" style={{ background: "#c9d2cd" }} />
          <span>{thread.player?.is_member ? "Member" : "Casual"}</span>
          {mine && (
            <>
              <span aria-hidden className="inline-block h-[3px] w-[3px] rounded-full" style={{ background: "#c9d2cd" }} />
              <span className="font-[700]" style={{ color: "#3f544a" }}>You</span>
            </>
          )}
        </span>
        <span data-testid="crm-thread-preview" className="mt-[5px] block overflow-hidden text-[12.5px] leading-[1.42]" style={{ color: "#63736b", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
          <span className={inbound ? "font-[700]" : "font-[700] italic"} style={{ color: inbound ? "#4a5f55" : "#8a978f" }}>{speaker}: </span>
          {preview || <span className="italic" style={{ color: "#8d9c94" }}>(no preview)</span>}
        </span>
        {waiting && (
          <span className="mt-1.5 inline-flex rounded-[6px] border px-[7px] py-0.5 text-[10px] font-[750]" style={{ background: "#fdf1d0", borderColor: "#e3c369", color: "#8a6300" }}>
            Waiting {awaitingAgeLabel(thread.waiting_since ?? thread.last_message_at, nowMs)}
          </span>
        )}
      </span>
    </button>
  );
}

// ============================================================
// All-caught-up card — the empty Open inbox is a WIN, not a broken filter.
// Shown only when the default view has a true open count of 0.
// ============================================================
function AllCaughtUpCard({ onReviewClosed, closedCount }: { onReviewClosed: () => void; closedCount: number }) {
  return (
    <div className="m-3 rounded-[16px] border p-[26px_22px] text-center" style={{ background: "#ffffff", borderColor: "#e2eae5", boxShadow: "0 1px 2px rgba(7,42,32,.05), 0 14px 30px -22px rgba(7,42,32,.5)" }}>
      <div className="mx-auto mb-[13px] flex h-[46px] w-[46px] items-center justify-center rounded-full" style={{ color: "#17724c", background: "radial-gradient(circle at 35% 30%,#eafaf1,#d6efe1)", boxShadow: "0 0 0 7px rgba(224,242,231,.5)" }}>
        <svg viewBox="0 0 24 24" className="h-[21px] w-[21px]" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} aria-hidden>
          <path d="M4.5 12.5l5 5 10-11" />
        </svg>
      </div>
      <h3 className="mb-1.5 text-[15px] font-[760] tracking-[-0.015em]" style={{ color: "#12241d" }}>All caught up</h3>
      <p className="mx-auto mb-3.5 max-w-[31ch] text-[12.5px] leading-[1.6]" style={{ color: "#6d7b74" }}>
        No player is waiting on a reply right now. New messages land here the moment they arrive.
      </p>
      <button type="button" onClick={onReviewClosed} className="mx-auto rounded-full border px-[13px] py-[7px] text-[12.5px] font-[650]" style={{ borderColor: "#e6ebe8", background: "#ffffff", color: "#3f544a" }}>
        Review closed ({closedCount})
      </button>
    </div>
  );
}

// ============================================================
// Empty state
// ============================================================
function EmptyConversation() {
  return (
    <div className="hidden flex-1 items-center justify-center lg:flex">
      <div className="max-w-sm px-6 text-center">
        <div aria-hidden className="text-3xl">
          💬
        </div>
        <div className="mt-2 text-sm font-bold text-deep-green">
          Select a conversation
        </div>
        <div className="mt-1 text-xs text-deep-green/55">
          Pick a player from the inbox to view messages and reply.
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Inbox skeleton — three placeholder rows while loading
// ============================================================
function InboxSkeleton() {
  return (
    <ul className="divide-y divide-cream-line">
      {[0, 1, 2, 3].map((i) => (
        <li
          key={i}
          className="flex items-center gap-3 px-3 py-2.5 sm:px-4"
          aria-hidden
        >
          <div className="h-10 w-10 shrink-0 rounded-full bg-cream-soft" />
          <div className="flex-1 space-y-1.5">
            <div className="h-3 w-2/3 rounded bg-cream-soft" />
            <div className="h-2.5 w-5/6 rounded bg-cream-soft" />
            <div className="h-2.5 w-1/3 rounded bg-cream-soft" />
          </div>
        </li>
      ))}
    </ul>
  );
}

// ============================================================
// Conversation (header + messages + composer)
// ============================================================
function Conversation({
  selectedId,
  detail,
  error,
  loading,
  appUserId,
  canSendMessages,
  operators,
  onAssign,
  onSent,
  onBack,
  onOpenContext,
  onToggleContext,
  contextOpen,
  isMember,
  isFollowUp,
  onToggleFollowUp,
  threadStatus,
  canManageStatus,
  onSetStatus,
  whatsappWindowExpired,
  onDock,
  isDocked,
}: {
  selectedId: string;
  detail: ThreadDetail | null;
  error: string | null;
  loading: boolean;
  appUserId: string | null;
  canSendMessages: boolean;
  operators: Assignee[];
  onAssign: (userId: string | null) => void;
  onSent: (m: Message) => void;
  onBack: () => void;
  onOpenContext: () => void;
  onToggleContext: () => void;
  contextOpen: boolean;
  isMember: boolean;
  isFollowUp: boolean;
  onToggleFollowUp: () => void;
  threadStatus: "open" | "closed";
  canManageStatus: boolean;
  onSetStatus: (action: "close" | "reopen") => void;
  whatsappWindowExpired: boolean;
  onDock?: () => void;
  isDocked?: boolean;
}) {
  const messages = detail?.messages ?? [];
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, selectedId]);

  const channel: CrmChannel =
    (detail?.thread.channel as CrmChannel | undefined) ?? "sms";

  return (
    <>
      <ConversationHeader
        detail={detail}
        operators={operators}
        onAssign={onAssign}
        onBack={onBack}
        onOpenContext={onOpenContext}
        onToggleContext={onToggleContext}
        contextOpen={contextOpen}
        isMember={isMember}
        isFollowUp={isFollowUp}
        onToggleFollowUp={onToggleFollowUp}
        threadStatus={threadStatus}
        canManageStatus={canManageStatus}
        onSetStatus={onSetStatus}
        onDock={onDock}
        isDocked={isDocked}
      />
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto overflow-x-hidden bg-white px-3 py-3 sm:px-4"
      >
        {error && (
          <div className="mb-3 rounded border border-coral/40 bg-coral-soft p-2 text-xs text-coral-hover">
            {error}
          </div>
        )}
        {loading && messages.length === 0 && (
          <div className="text-xs text-deep-green/50">Loading messages…</div>
        )}
        {!loading && messages.length === 0 && !error && (
          <div className="text-xs text-deep-green/50">
            No messages in this thread yet.
          </div>
        )}
        <ConversationList messages={messages as ConversationMessage[]} />
      </div>
      <Composer
        threadId={selectedId}
        appUserId={appUserId}
        canSendMessages={canSendMessages}
        channel={channel}
        whatsappWindowExpired={whatsappWindowExpired}
        customerName={detail?.thread.player?.first_name?.trim() ?? ""}
        onSent={onSent}
      />
    </>
  );
}

// ============================================================
// Conversation list with date dividers + direction-aware spacing
// ============================================================
// Replaces the flat `space-y-2.5` list. Visual rhythm:
//
//   ┌ same-direction bubble  (mt-3 = 12px gap above)
//   ┌ different-direction    (mt-6 = 24px gap above)
//   ─ date divider ─         (own py-3, ~32px total around it)
//
// Date divider triggers:
//   - first message ever in the thread
//   - calendar-day change between consecutive messages
//   - >2 hour gap (renders a time label, not a date)
//
// Tight spacing on the SAME direction simulates the iOS Messages
// idiom where rapid-fire replies stack close. Direction switches
// get more breathing room so the eye can re-anchor.

type ConversationItem =
  | { kind: "msg"; msg: ConversationMessage; marginTop: string }
  | { kind: "divider"; key: string; label: string };

const GAP_MS = 2 * 60 * 60 * 1000; // 2 hours

function dateKeyOf(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function friendlyDateLabel(d: Date): string {
  const today = new Date();
  const todayKey = dateKeyOf(today);
  const yest = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  const yestKey = dateKeyOf(yest);
  const k = dateKeyOf(d);
  if (k === todayKey) return "Today";
  if (k === yestKey) return "Yesterday";
  const diffDays = Math.floor(
    (today.getTime() - d.getTime()) / (24 * 60 * 60 * 1000),
  );
  if (diffDays >= 0 && diffDays < 7) {
    return d.toLocaleDateString(undefined, { weekday: "long" });
  }
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year:
      d.getFullYear() === today.getFullYear() ? undefined : "numeric",
  });
}

function friendlyTimeLabel(d: Date): string {
  return d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function buildConversationItems(
  messages: ConversationMessage[],
): ConversationItem[] {
  const out: ConversationItem[] = [];
  let prevDateKey: string | null = null;
  let prevTime: number | null = null;
  let prevDirection: "inbound" | "outbound" | null = null;

  messages.forEach((m, i) => {
    const d = new Date(m.sent_at);
    const t = d.getTime();
    const dKey = dateKeyOf(d);
    const dayChanged = prevDateKey !== null && dKey !== prevDateKey;
    const bigGap = prevTime !== null && t - prevTime > GAP_MS;
    const isFirst = prevDateKey === null;

    if (isFirst || dayChanged) {
      out.push({
        kind: "divider",
        key: `d-${i}`,
        label: friendlyDateLabel(d),
      });
    } else if (bigGap) {
      // Mid-day gap — show the time the next message landed at.
      out.push({
        kind: "divider",
        key: `g-${i}`,
        label: friendlyTimeLabel(d),
      });
    }

    let marginTop = "mt-3"; // 12px — same direction default
    if (prevDirection !== null && prevDirection !== m.direction) {
      marginTop = "mt-6"; // 24px — direction switch
    }
    if (isFirst || dayChanged || bigGap) {
      marginTop = "mt-0"; // divider supplies the vertical rhythm
    }

    out.push({ kind: "msg", msg: m, marginTop });
    prevDateKey = dKey;
    prevTime = t;
    prevDirection = m.direction;
  });

  return out;
}

function ConversationList({
  messages,
}: {
  messages: ConversationMessage[];
}) {
  const items = useMemo(() => buildConversationItems(messages), [messages]);
  return (
    <ul>
      {items.map((it) => {
        if (it.kind === "divider") {
          return (
            <li
              key={it.key}
              className="flex items-center gap-2 py-3"
              aria-label={`Conversation divider: ${it.label}`}
            >
              <hr className="flex-1 border-cream-line" />
              <span className="text-[10px] font-medium uppercase tracking-wider text-deep-green/40">
                {it.label}
              </span>
              <hr className="flex-1 border-cream-line" />
            </li>
          );
        }
        return (
          <MessageBubble
            key={it.msg.id}
            msg={it.msg}
            className={it.marginTop}
          />
        );
      })}
    </ul>
  );
}

function ConversationHeader({
  detail,
  operators,
  onAssign,
  onBack,
  onOpenContext,
  onToggleContext,
  contextOpen,
  isMember,
  isFollowUp,
  onToggleFollowUp,
  threadStatus,
  canManageStatus,
  onSetStatus,
  onDock,
  isDocked,
}: {
  detail: ThreadDetail | null;
  operators: Assignee[];
  onAssign: (userId: string | null) => void;
  onBack: () => void;
  onOpenContext: () => void;
  onToggleContext: () => void;
  contextOpen: boolean;
  isMember: boolean;
  isFollowUp: boolean;
  onToggleFollowUp: () => void;
  threadStatus: "open" | "closed";
  canManageStatus: boolean;
  onSetStatus: (action: "close" | "reopen") => void;
  onDock?: () => void;
  isDocked?: boolean;
}) {
  // Wrap onBack so any underlying touchstart/click ordering bugs
  // can't fall through to a parent handler. Bumped to h-11 w-11
  // (44px) to clear the iOS recommended tap-target floor — at
  // h-9 w-9 (36px) the chevron was tapping a hairline off-target
  // on small phones and the user reported it as a no-op.
  const handleBack = (e: React.MouseEvent | React.TouchEvent) => {
    e.stopPropagation();
    onBack();
  };

  if (!detail) {
    return (
      <div className="flex min-h-14 shrink-0 items-center gap-2 border-b border-cream-line bg-white px-2 pt-[var(--sat)] sm:px-4">
        <button
          type="button"
          onClick={handleBack}
          aria-label="Back to inbox"
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-deep-green/70 hover:bg-cream-soft hover:text-deep-green lg:hidden"
        >
          <ChevronLeft aria-hidden className="h-5 w-5" />
        </button>
        <div className="h-3 w-32 rounded bg-cream-soft" />
      </div>
    );
  }
  const name = fullNameOf(detail.thread);
  const cityCode = cityCodeForThread(detail.thread);
  const channel = detail.thread.channel ?? "sms";
  return (
    <div data-testid="crm-conv-header" data-thread-id={detail.thread.id} data-amb={detail.thread.match_ambiguous ? 1 : 0} className="flex min-h-14 shrink-0 items-center gap-2 border-b border-cream-line bg-white px-1 pt-[var(--sat)] sm:px-3">
      <button
        type="button"
        onClick={handleBack}
        aria-label="Back to inbox"
        className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-deep-green/70 hover:bg-cream-soft hover:text-deep-green lg:hidden"
      >
        <ChevronLeft aria-hidden className="h-5 w-5" />
      </button>
      <PlayerAvatar
        name={name}
        seed={detail.thread.phone_number}
        channel={channel}
        size="sm"
        isMember={isMember}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-extrabold tracking-tight text-deep-green">
          {name}
        </div>
        {/* Mobile (<lg): show only the phone number under the name —
            avatar already carries the channel icon. The richer chip
            row (city, "via WhatsApp", historical) lives behind
            `hidden lg:flex` and stays accessible on mobile via the
            info-icon sheet. */}
        <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-deep-green/55">
          <span className="truncate font-mono lg:hidden">
            {detail.thread.phone_number}
          </span>
          <div className="hidden items-center gap-1.5 lg:flex">
            <CityChip code={cityCode} />
            <span aria-hidden>·</span>
            <span className="inline-flex items-center gap-0.5">
              <ChannelChip channel={channel} />
              via {channelDisplay(channel)}
            </span>
            {detail.thread.match_ambiguous && (
              <>
                <span aria-hidden>·</span>
                {/* >1 account shares this phone; we attached the newest (created_at). It may not be
                    who is writing — see the fuller note in the context pane. Amber, informational. */}
                <span
                  title={`This number is on more than one account. Showing ${name} — it may not be who is writing.`}
                  className="inline-flex items-center gap-0.5 rounded-full bg-amber-100 px-1.5 py-px font-medium text-amber-800"
                >
                  <span aria-hidden>⚠</span> shared number
                </span>
              </>
            )}
          </div>
        </div>
      </div>
      {/* Phase 19 Step 3a — pin this conversation to the dock so it follows the operator to other
          Match Ops screens. The dock is hidden here on Player Chats; the DOCKED pill is the on-screen
          confirmation that it's pinned. */}
      {onDock &&
        (isDocked ? (
          <span
            data-testid="dock-pin-current"
            data-docked="1"
            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-deep-green/10 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-deep-green"
            title="This chat is docked — it follows you across Match Ops"
          >
            <Pin aria-hidden className="h-3 w-3" /> Docked
          </span>
        ) : (
          <button
            type="button"
            data-testid="dock-pin-current"
            data-docked="0"
            onClick={onDock}
            aria-label="Dock this chat"
            title="Dock this chat — keep it open on other Match Ops screens"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-deep-green/60 hover:bg-cream-soft hover:text-deep-green"
          >
            <Pin aria-hidden className="h-4 w-4" />
          </button>
        ))}
      <AssignDropdown
        current={detail.assignee}
        operators={operators}
        onAssign={onAssign}
        trigger={({ open }) => (
          <AssigneeChip
            assignee={detail.assignee}
            size="md"
            trailing={
              <span aria-hidden className="text-[9px] leading-none opacity-60">
                {open ? "▴" : "▾"}
              </span>
            }
          />
        )}
      />
      {/* Follow-up star — per-viewer flag for "return to this". Coral
          fill when set; toggles optimistically via the same handler as
          the inbox row. */}
      <button
        type="button"
        onClick={onToggleFollowUp}
        aria-label={isFollowUp ? "Remove follow-up flag" : "Mark for follow up"}
        aria-pressed={isFollowUp}
        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition hover:bg-cream-soft"
      >
        <Star
          aria-hidden
          className={`h-4 w-4 ${
            isFollowUp ? "fill-coral text-coral" : "text-deep-green/70"
          }`}
          strokeWidth={1.75}
        />
      </button>
      {/* Close / Reopen — ticket workflow. Any chat operator (admin or
          can_access_chats). Close acts immediately (with an Undo toast
          for a few seconds after); Reopen is a direct action too. */}
      {canManageStatus &&
        (threadStatus === "open" ? (
          <button
            type="button"
            onClick={() => onSetStatus("close")}
            aria-label="Close conversation"
            className="inline-flex h-9 shrink-0 items-center gap-1 rounded-full px-2.5 text-xs font-medium text-deep-green/70 transition hover:bg-cream-soft hover:text-deep-green"
          >
            <CircleCheck aria-hidden className="h-4 w-4" strokeWidth={1.75} />
            <span className="hidden sm:inline">Close</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={() => onSetStatus("reopen")}
            aria-label="Reopen conversation"
            className="inline-flex h-9 shrink-0 items-center gap-1 rounded-full px-2.5 text-xs font-medium text-deep-green/70 transition hover:bg-cream-soft hover:text-deep-green"
          >
            <RotateCcw aria-hidden className="h-4 w-4" strokeWidth={1.75} />
            <span className="hidden sm:inline">Reopen</span>
          </button>
        ))}
      {/* Info button — toggles the context panel. Two variants
          stacked behind responsive utilities so the same icon does
          the right thing on each surface:
            mobile (<lg): opens the slide-up sheet
            desktop (lg+): toggles the right-column panel, preserves
                           the open/closed state in localStorage
                           (crm:contextOpen:v1). */}
      <button
        type="button"
        onClick={onOpenContext}
        aria-label="Player context"
        className="inline-flex h-9 w-9 items-center justify-center rounded-full text-deep-green/70 hover:bg-cream-soft hover:text-deep-green lg:hidden"
      >
        <Info aria-hidden className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={onToggleContext}
        aria-label={contextOpen ? "Hide player context" : "Show player context"}
        aria-pressed={contextOpen}
        className={`hidden h-9 w-9 items-center justify-center rounded-full transition lg:inline-flex ${
          contextOpen
            ? "bg-cream-soft text-deep-green"
            : "text-deep-green/70 hover:bg-cream-soft hover:text-deep-green"
        }`}
      >
        <Info aria-hidden className="h-4 w-4" />
      </button>
    </div>
  );
}

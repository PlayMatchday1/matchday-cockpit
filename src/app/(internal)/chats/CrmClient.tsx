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
//   ?cities=A,B   — multi-select city filter
//   ?view=…       — ticket status view: open (default, omitted) |
//                   mine | starred | closed
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
  RotateCcw,
  SlidersHorizontal,
  Star,
} from "lucide-react";
import EnablePushNotificationsButton from "@/components/EnablePushNotificationsButton";
import PlayersMatchesToggle from "@/components/PlayersMatchesToggle";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/useAuth";
import { UNKNOWN_CITY } from "@/lib/cityColors";
import CityChip from "@/components/CityChip";
import AssigneeChip, { type Assignee } from "@/components/AssigneeChip";
import ChannelChip, {
  channelDisplay,
  type CrmChannel,
} from "@/components/ChannelChip";
import PlayerAvatar from "@/components/PlayerAvatar";
import type { DeliveryStatus } from "@/components/DeliveryStatusLabel";
import type { MatchStatus } from "@/components/MatchStatusPill";
import FilterBar, {
  type StatusFilter,
  type ViewCounts,
} from "./components/FilterBar";
import InboxRow, { type InboxRowThread } from "./components/InboxRow";
import AssignDropdown from "./components/AssignDropdown";
import MessageBubble, {
  type ConversationMessage,
} from "./components/MessageBubble";
import Composer from "./components/Composer";
import ContextPanel from "./components/ContextPanel";

// ---------------- shared types ----------------

type ThreadListRow = {
  id: string;
  phone_number: string;
  player_id: number | null;
  match_ambiguous: boolean;
  last_message_at: string;
  last_message_preview: string | null;
  last_message_direction: "inbound" | "outbound" | null;
  created_at: string;
  assigned_to_user_id: string | null;
  assigned_at: string | null;
  channel: CrmChannel;
  // Ticket status. 'open' threads live in the Open inbox; 'closed'
  // ones move to the Closed view. Auto-reopens to 'open' on a new
  // inbound. closed_at / closed_by_user_id are set on close, cleared
  // on reopen.
  status: "open" | "closed";
  closed_at: string | null;
  closed_by_user_id: string | null;
  // Server-computed per the assignment-aware rule. Authoritative —
  // the client mirrors this for optimistic updates on mark-read but
  // never recomputes the rule itself.
  is_unread: boolean;
  // Per-viewer follow-up star. Server-computed; optimistically patched
  // on toggle. (Not a crm_threads column, so realtime crm_threads
  // UPDATEs never carry it — the selective merge preserves it.)
  is_follow_up: boolean;
  player: {
    first_name: string | null;
    last_name: string | null;
    preferable_city_normalized: string | null;
    is_member?: boolean | null;
  } | null;
  assignee: Assignee | null;
};

type Message = {
  id: string;
  thread_id: string;
  direction: "inbound" | "outbound";
  body: string;
  sent_at: string;
  sent_by_user_id: string | null;
  telnyx_message_id: string | null;
  external_message_id: string | null;
  segment_count: number;
  channel: CrmChannel;
  delivery_status: DeliveryStatus;
  delivery_status_updated_at: string | null;
  sender?: { email: string; full_name: string | null } | null;
  // Media columns. media_url (Storage path) is stripped by the
  // detail route; clients receive the short-lived signed_media_url
  // instead. Realtime INSERT payloads from Supabase do NOT include
  // signed_media_url (it is minted server-side per request), so
  // images that arrive via realtime fall back to caption-only
  // rendering until the next thread refetch.
  media_kind:
    | "image"
    | "video"
    | "audio"
    | "document"
    | "sticker"
    | "reaction"
    | null;
  media_filename?: string | null;
  media_size_bytes?: number | null;
  signed_media_url?: string | null;
  reaction_target_wamid?: string | null;
};

// Chat-pane data only. Player + recent/upcoming matches +
// historical-account count moved to /api/crm/threads/{id}/context
// (Phase 3 split, 2026-05-17). ContextPanel fetches that endpoint
// lazily when it becomes visible. Keeps initial thread switching
// fast — chat pane no longer waits on heavy match queries.
type ThreadDetail = {
  thread: ThreadListRow;
  messages: Message[];
  assignee: Assignee | null;
  latest_inbound_at: string | null;
};

// One row of the lightweight all-threads index the server returns
// alongside the list. Drives chip counts scoped to the selected
// cities without refetching on every city toggle.
type CountIndexRow = {
  city: string;
  status: "open" | "closed";
  mine: boolean;
  starred: boolean;
};

// ---------------- constants ----------------

const WHATSAPP_WINDOW_MS = 24 * 60 * 60 * 1000;

// ---------------- helpers ----------------

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

async function bearerHeaders(): Promise<Record<string, string> | null> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return null;
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

// Fire-and-forget. Best-effort: if it fails the optimistic local
// clear stays and we converge on the next realtime refetch.
async function markThreadRead(threadId: string): Promise<void> {
  const headers = await bearerHeaders();
  if (!headers) return;
  try {
    await fetch(`/api/crm/threads/${threadId}/mark-read`, {
      method: "POST",
      headers,
    });
  } catch {
    // Silent — the inbox will reconcile on the next refetch.
  }
}

function computeWhatsAppExpired(detail: ThreadDetail | null): boolean {
  if (!detail) return false;
  if ((detail.thread.channel ?? "sms") !== "whatsapp") return false;
  const iso = detail.latest_inbound_at;
  if (!iso) return true;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return true;
  return Date.now() - t > WHATSAPP_WINDOW_MS;
}

// ---------------- main ----------------

export default function CrmClient() {
  const { appUser } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();

  // --------- URL state ---------
  const cityFilter = useMemo<Set<string>>(() => {
    const raw = searchParams.get("cities");
    if (!raw) return new Set();
    return new Set(raw.split(",").filter((c) => c.length > 0));
  }, [searchParams]);

  // Ticket-style status view (single-select). Defaults to Open — the
  // main inbox. Filtered server-side; changing it refetches.
  const view = useMemo<StatusFilter>(() => {
    const raw = searchParams.get("view");
    if (raw === "mine" || raw === "starred" || raw === "closed") return raw;
    return "open";
  }, [searchParams]);

  const selectedId = searchParams.get("threadId");

  const setFilters = useCallback(
    (next: { cities?: Set<string>; view?: StatusFilter }) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next.cities !== undefined) {
        if (next.cities.size === 0) params.delete("cities");
        else params.set("cities", [...next.cities].join(","));
      }
      if (next.view !== undefined) {
        if (next.view === "open") params.delete("view");
        else params.set("view", next.view);
      }
      const qs = params.toString();
      router.replace(qs ? `/chats?${qs}` : "/chats", { scroll: false });
    },
    [router, searchParams],
  );

  const setSelected = useCallback(
    (id: string | null) => {
      const params = new URLSearchParams(searchParams.toString());
      if (id == null) params.delete("threadId");
      else params.set("threadId", id);
      const qs = params.toString();
      router.replace(qs ? `/chats?${qs}` : "/chats", { scroll: false });
    },
    [router, searchParams],
  );

  // --------- data state ---------
  const [threads, setThreads] = useState<ThreadListRow[]>([]);
  const [threadsError, setThreadsError] = useState<string | null>(null);
  const [threadsLoading, setThreadsLoading] = useState(true);

  // Server-computed global per-view counts + a lightweight all-threads
  // index used to recompute counts scoped to the selected cities.
  const ZERO_COUNTS: ViewCounts = { open: 0, mine: 0, starred: 0, closed: 0 };
  const [counts, setCounts] = useState<ViewCounts>(ZERO_COUNTS);
  const [countIndex, setCountIndex] = useState<CountIndexRow[]>([]);

  // The active view lives in the URL. loadThreads reads it through a
  // ref so its identity stays stable — the realtime subscription
  // depends on loadThreads and must not resubscribe on every view
  // change.
  const viewRef = useRef<StatusFilter>(view);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  const [operators, setOperators] = useState<Assignee[]>([]);
  const operatorsById = useMemo(
    () => new Map(operators.map((o) => [o.id, o])),
    [operators],
  );

  const [detail, setDetail] = useState<ThreadDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [realtimeOk, setRealtimeOk] = useState<boolean | null>(null);

  // Mobile context-panel sheet open/close. Desktop uses the
  // separate `contextOpen` state below.
  const [contextSheetOpen, setContextSheetOpen] = useState(false);

  // Desktop (lg+) right-column toggle. Persisted per-browser via
  // localStorage so the operator's preference survives reloads.
  // Default: closed — keeps the chat pane wider on first visit, and
  // anyone who wants the column back is one click away (Info button
  // in the conversation header).
  const [contextOpen, setContextOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      const raw = window.localStorage.getItem("crm:contextOpen:v1");
      return raw === "true";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(
        "crm:contextOpen:v1",
        contextOpen ? "true" : "false",
      );
    } catch {
      // Silent — Safari private-mode storage quota, etc.
    }
  }, [contextOpen]);

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

  // --------- fetchers ---------
  const loadThreads = useCallback(async () => {
    setThreadsError(null);
    const headers = await bearerHeaders();
    if (!headers) {
      setThreadsError("No active session — please sign in again.");
      setThreadsLoading(false);
      return;
    }
    try {
      const res = await fetch(
        `/api/crm/threads?view=${encodeURIComponent(viewRef.current)}`,
        { headers },
      );
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      const j = (await res.json()) as {
        threads: ThreadListRow[];
        counts?: ViewCounts;
        index?: CountIndexRow[];
      };
      setThreads(j.threads);
      if (j.counts) setCounts(j.counts);
      if (j.index) setCountIndex(j.index);
    } catch (err) {
      setThreadsError(err instanceof Error ? err.message : String(err));
    } finally {
      setThreadsLoading(false);
    }
  }, []);

  const loadOperators = useCallback(async () => {
    const headers = await bearerHeaders();
    if (!headers) return;
    try {
      const res = await fetch("/api/crm/operators", { headers });
      if (!res.ok) return;
      const j = (await res.json()) as { operators: Assignee[] };
      setOperators(j.operators);
    } catch {
      /* dropdown stays empty — non-fatal */
    }
  }, []);

  const loadDetail = useCallback(async (threadId: string) => {
    setDetailError(null);
    setDetailLoading(true);
    const headers = await bearerHeaders();
    if (!headers) {
      setDetailError("No active session — please sign in again.");
      setDetailLoading(false);
      return;
    }
    try {
      const res = await fetch(`/api/crm/threads/${threadId}`, { headers });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      const j = (await res.json()) as ThreadDetail;
      setDetail(j);
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : String(err));
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  // Silent refetch used when a realtime INSERT carries a media_kind.
  // The postgres_changes payload does NOT include signed_media_url
  // (minted server-side per request), so for media rows we replace
  // the local detail with a fresh fetch that includes signed URLs.
  // Does NOT toggle detailLoading so the bubble area doesn't flash.
  // Race-safe: re-checks selectedRef before applying.
  const refreshDetailForMediaInsert = useCallback(
    async (threadId: string): Promise<void> => {
      if (selectedRef.current !== threadId) return;
      const headers = await bearerHeaders();
      if (!headers) return;
      try {
        const res = await fetch(`/api/crm/threads/${threadId}`, { headers });
        if (!res.ok) return;
        const j = (await res.json()) as ThreadDetail;
        if (selectedRef.current !== threadId) return;
        setDetail(j);
      } catch {
        // Silent best-effort. If the refetch fails, the optimistically
        // appended raw payload is still in state with media_kind set
        // but no signed URL; the bubble falls back to caption-text
        // rendering until the next thread re-select.
      }
    },
    [],
  );

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
      setContextSheetOpen(false);
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

  // --------- realtime ---------
  const selectedRef = useRef<string | null>(null);
  useEffect(() => {
    selectedRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    const channel = supabase
      .channel("crm-stream-v2")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "crm_messages" },
        (payload) => {
          const m = payload.new as Message;
          if (m.thread_id === selectedRef.current) {
            if (m.media_kind) {
              // Media row — the realtime payload lacks
              // signed_media_url (minted server-side per request).
              // Refetch the thread so the bubble can render the
              // image instead of falling back to caption-only.
              // Text-only rows skip this to avoid an extra round-
              // trip on every inbound message.
              console.debug(
                `[crm:realtime] media INSERT, refetching thread=${m.thread_id} kind=${m.media_kind}`,
              );
              void refreshDetailForMediaInsert(m.thread_id);
            } else {
              setDetail((prev) => {
                if (!prev) return prev;
                if (prev.messages.some((x) => x.id === m.id)) return prev;
                return { ...prev, messages: [...prev.messages, m] };
              });
            }
          }
          setThreads((prev) =>
            prev.map((t) =>
              t.id === m.thread_id
                ? {
                    ...t,
                    last_message_at: m.sent_at,
                    last_message_preview: m.body.slice(0, 80),
                    last_message_direction: m.direction,
                  }
                : t,
            ),
          );
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "crm_messages" },
        (payload) => {
          const m = payload.new as Message;
          if (m.thread_id !== selectedRef.current) return;
          setDetail((prev) => {
            if (!prev) return prev;
            const i = prev.messages.findIndex((x) => x.id === m.id);
            if (i === -1) return prev;
            const merged: Message = { ...prev.messages[i], ...m };
            const next = prev.messages.slice();
            next[i] = merged;
            return { ...prev, messages: next };
          });
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "crm_threads" },
        (payload) => {
          const t = payload.new as ThreadListRow;
          setThreads((prev) => {
            const exists = prev.find((x) => x.id === t.id);
            if (!exists) {
              // Not in the current view — a reopen or reassignment may
              // now make it belong here. Refetch to re-evaluate
              // membership (and counts).
              void loadThreads();
              return prev;
            }
            // A status flip (close / reopen / auto-reopen) can change
            // which view this thread belongs to. Refetch rather than
            // patch so it drops out of / into the right list and the
            // counts stay correct.
            if ((exists.status ?? "open") !== (t.status ?? "open")) {
              void loadThreads();
              return prev;
            }
            return prev.map((x) =>
              x.id === t.id
                ? {
                    ...x,
                    last_message_at: t.last_message_at,
                    last_message_preview: t.last_message_preview,
                    match_ambiguous: t.match_ambiguous,
                    player_id: t.player_id,
                    assigned_to_user_id: t.assigned_to_user_id,
                    assigned_at: t.assigned_at,
                    status: t.status,
                    closed_at: t.closed_at,
                    closed_by_user_id: t.closed_by_user_id,
                    assignee:
                      t.assigned_to_user_id != null
                        ? operatorsById.get(t.assigned_to_user_id) ??
                          x.assignee
                        : null,
                  }
                : x,
            );
          });
          if (selectedRef.current === t.id) {
            setDetail((prev) =>
              prev
                ? {
                    ...prev,
                    thread: { ...prev.thread, ...t },
                    assignee:
                      t.assigned_to_user_id != null
                        ? operatorsById.get(t.assigned_to_user_id) ??
                          prev.assignee
                        : null,
                  }
                : prev,
            );
          }
        },
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "crm_threads" },
        () => {
          void loadThreads();
        },
      )
      // Same-user multi-device read-state sync. When this viewer
      // reads a thread on another device, their crm_thread_reads
      // row updates and this session refetches to clear the dot.
      // Cross-admin reads of unassigned threads converge through the
      // separate crm_threads UPDATE subscription above, fired by the
      // 0035 trigger that touches reads_updated_at.
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "crm_thread_reads",
          filter: appUser?.id ? `user_id=eq.${appUser.id}` : undefined,
        },
        () => {
          void loadThreads();
        },
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") setRealtimeOk(true);
        else if (
          status === "CHANNEL_ERROR" ||
          status === "TIMED_OUT" ||
          status === "CLOSED"
        ) {
          setRealtimeOk(false);
        }
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [loadThreads, operatorsById, refreshDetailForMediaInsert, appUser?.id]);

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
      if (cityFilter.size > 0 && !cityFilter.has(cityCodeForThread(t)))
        return false;
      if (view === "starred" && !t.is_follow_up) return false;
      return true;
    });
  }, [threads, cityFilter, view]);

  // Chip counts. The server sends global per-view counts plus a
  // lightweight all-threads index. With no city selected we show the
  // global counts; with cities selected we recompute scoped to those
  // cities from the index (e.g. "Open + DFW" = open threads in DFW).
  const displayedCounts = useMemo<ViewCounts>(() => {
    if (cityFilter.size === 0) return counts;
    const inCity = (r: CountIndexRow) => cityFilter.has(r.city);
    return {
      open: countIndex.filter((r) => r.status === "open" && inCity(r)).length,
      mine: countIndex.filter((r) => r.mine && inCity(r)).length,
      starred: countIndex.filter((r) => r.starred && inCity(r)).length,
      closed: countIndex.filter((r) => r.status === "closed" && inCity(r))
        .length,
    };
  }, [counts, countIndex, cityFilter]);

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

  const onSent = useCallback(
    (msg: Message) => {
      setDetail((prev) =>
        prev
          ? prev.messages.some((m) => m.id === msg.id)
            ? prev
            : { ...prev, messages: [...prev.messages, msg] }
          : prev,
      );
      setThreads((prev) =>
        prev.map((t) =>
          t.id === msg.thread_id
            ? {
                ...t,
                last_message_at: msg.sent_at,
                last_message_preview: msg.body.slice(0, 80),
                last_message_direction: msg.direction,
              }
            : t,
        ),
      );
    },
    [],
  );

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

  // Close / reopen the selected conversation (admin-only; the button is
  // hidden for non-admins and the API rejects them too). Optimistic:
  // flip the local status so the header button and inbox reflect it
  // immediately, then refetch in `finally` to reconcile view membership
  // and counts (also self-heals if the request failed).
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
    [loadThreads],
  );

  const whatsappExpired = computeWhatsAppExpired(detail);
  const canManageStatus = appUser?.is_admin === true;

  // Mobile flow rules:
  //   no selectedId             → inbox full-screen
  //   selectedId on mobile      → conversation full-screen + back arrow
  //   selectedId on desktop     → both panes side-by-side
  // Implemented via Tailwind responsive `hidden lg:flex` rather than
  // JS branching so the layout doesn't reflow on viewport change.
  const showInboxMobile = !selectedId;
  const showConversationMobile = !!selectedId;

  return (
    // Wrapper escape and viewport-height math live in /chats/page.tsx
    // so this client owns one full-bleed area flush under the top
    // nav. min-h-0 + flex-1 lets this column expand to fill whatever
    // height the page wrapper grants.
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-cream">
      <ChatsHeader
        threadsLoading={threadsLoading}
        totalThreads={threads.length}
        visibleThreads={visibleThreads.length}
        realtimeOk={realtimeOk}
        onRefresh={() => void loadThreads()}
        cities={cityFilter}
        view={view}
        counts={displayedCounts}
        onFilterChange={setFilters}
        canFilterMine={!!appUser?.id}
      />

      <div className="flex min-h-0 min-w-0 flex-1">
        {/* --- LEFT PANE: inbox (filter row lives in ChatsHeader) --- */}
        <aside
          className={`flex-col border-r border-cream-line bg-white min-w-0 lg:flex lg:w-[280px] lg:shrink-0 ${
            showInboxMobile ? "flex flex-1" : "hidden lg:flex"
          }`}
        >
          <div className="flex flex-1 flex-col overflow-y-auto overflow-x-hidden">
            {threadsError && (
              <div className="m-2 rounded border border-coral/40 bg-coral-soft p-2 text-xs text-coral-hover">
                {threadsError}
              </div>
            )}
            {threadsLoading && visibleThreads.length === 0 && (
              <InboxSkeleton />
            )}
            {!threadsLoading &&
              visibleThreads.length === 0 &&
              !threadsError && (
                <div className="flex flex-1 items-center justify-center px-6 text-center text-xs text-deep-green/45">
                  No conversations match the current filters.
                </div>
              )}
            {visibleThreads.length > 0 && (
              <ul className="divide-y divide-cream-line">
                {visibleThreads.map((t) => (
                  <InboxRow
                    key={t.id}
                    thread={t as InboxRowThread}
                    active={t.id === selectedId}
                    onSelect={() => setSelected(t.id)}
                    onToggleFollowUp={() =>
                      onToggleFollowUp(t.id, !t.is_follow_up)
                    }
                  />
                ))}
              </ul>
            )}
          </div>
        </aside>

        {/* --- CENTER PANE: conversation --- */}
        <section
          className={`flex-col bg-cream lg:flex lg:flex-1 ${
            showConversationMobile ? "flex flex-1" : "hidden lg:flex"
          }`}
        >
          {!selectedId ? (
            <EmptyConversation />
          ) : !selectedThread && !detail ? (
            <div className="flex flex-1 items-center justify-center text-xs text-deep-green/45">
              Loading conversation…
            </div>
          ) : (
            <Conversation
              selectedId={selectedId}
              detail={detail}
              error={detailError}
              loading={detailLoading}
              appUserId={appUser?.id ?? null}
              operators={operators}
              onAssign={(userId) => onAssign(selectedId, userId)}
              onSent={onSent}
              onBack={() => setSelected(null)}
              onOpenContext={() => setContextSheetOpen(true)}
              onToggleContext={() => setContextOpen((o) => !o)}
              contextOpen={contextOpen}
              isMember={selectedThread?.player?.is_member === true}
              isFollowUp={selectedThread?.is_follow_up ?? false}
              onToggleFollowUp={() =>
                onToggleFollowUp(
                  selectedId,
                  !(selectedThread?.is_follow_up ?? false),
                )
              }
              threadStatus={detail?.thread.status ?? selectedThread?.status ?? "open"}
              canManageStatus={canManageStatus}
              onSetStatus={(action) => onSetThreadStatus(selectedId, action)}
              whatsappWindowExpired={whatsappExpired}
            />
          )}
        </section>

        {/* --- RIGHT PANE: context (desktop column) ---
            Gated on both a selected thread AND the user's persisted
            contextOpen preference. When closed, the column unmounts
            entirely so the center pane expands to fill the freed
            240px. The Info button in the conversation header toggles
            it back. ContextPanel itself fetches player + matches
            lazily via /api/crm/threads/{id}/context, so mounting
            the column doesn't fire a fetch until it's actually
            visible. */}
        {selectedThread && contextOpen && (
          <ContextPanel
            mode="column"
            open={false}
            visible
            thread={{
              id: selectedThread.id,
              phone_number: selectedThread.phone_number,
              match_ambiguous: selectedThread.match_ambiguous,
            }}
          />
        )}
      </div>

      {/* Mobile context sheet — unmounted when closed (sheet branch
          of ContextPanel returns null on !open), which avoids the
          md-viewport click-block bug where role=dialog markup hung
          around behind a CSS-hidden parent. */}
      <ContextPanel
        mode="sheet"
        open={contextSheetOpen}
        visible={contextSheetOpen}
        onClose={() => setContextSheetOpen(false)}
        thread={
          selectedThread
            ? {
                id: selectedThread.id,
                phone_number: selectedThread.phone_number,
                match_ambiguous: selectedThread.match_ambiguous,
              }
            : null
        }
      />
    </div>
  );
}

// ============================================================
// Chats header — brand-aligned title bar + Players/Matches
// segmented control + merged filter row + tiny status line.
// Replaces the old PageStatusBar combo.
// ============================================================
function ChatsHeader({
  threadsLoading,
  totalThreads,
  visibleThreads,
  realtimeOk,
  onRefresh,
  cities,
  view,
  counts,
  onFilterChange,
  canFilterMine,
}: {
  threadsLoading: boolean;
  totalThreads: number;
  visibleThreads: number;
  realtimeOk: boolean | null;
  onRefresh: () => void;
  cities: Set<string>;
  view: StatusFilter;
  counts: ViewCounts;
  onFilterChange: (next: { cities?: Set<string>; view?: StatusFilter }) => void;
  canFilterMine: boolean;
}) {
  // Filter row defaults to visible. The icon collapses it when the
  // operator wants the bare inbox; a small mint dot on the icon
  // signals "filters are active" so a collapsed state never hides a
  // surprising filtered view. "Open" with no city is the default view,
  // so it does not count as an active filter.
  const [filtersOpen, setFiltersOpen] = useState(true);
  const filtersActive = view !== "open" || cities.size > 0;

  const liveLabel =
    realtimeOk == null
      ? "connecting"
      : realtimeOk
        ? "live"
        : "offline";
  const liveDot =
    realtimeOk == null
      ? "bg-muted"
      : realtimeOk
        ? "bg-mint"
        : "bg-coral";
  const filtered = visibleThreads !== totalThreads;
  const countLabel = threadsLoading
    ? "Loading"
    : filtered
      ? `${visibleThreads} of ${totalThreads}`
      : `${totalThreads} conversation${totalThreads === 1 ? "" : "s"}`;

  return (
    <header className="min-w-0 shrink-0">
      {/* Title bar — safe-area spacer + content row stacked. Splitting
          the two means status-bar clearance does not depend on the
          items-center + min-height + padding-top interaction, which
          mis-centered the toggle on iOS Safari (PR #57 regression on
          /match-chats). Same pattern applied here so /chats stays
          robust to the same iOS quirk. */}
      <div aria-hidden className="bg-deep-green" style={{ height: "var(--safe-area-top)" }} />
      <div className="flex min-h-12 items-center justify-between bg-deep-green px-3 sm:px-4">
        <h1 className="text-base font-bold tracking-tight text-cream">Chats</h1>
        <button
          type="button"
          onClick={() => setFiltersOpen((o) => !o)}
          aria-label={filtersOpen ? "Hide filters" : "Show filters"}
          aria-expanded={filtersOpen}
          style={{ touchAction: "manipulation" }}
          className="relative flex h-11 w-11 items-center justify-center rounded-full text-cream/85 transition hover:bg-deep-green-soft hover:text-cream"
        >
          <SlidersHorizontal aria-hidden size={18} strokeWidth={1.75} />
          {filtersActive && (
            <span
              aria-hidden
              className="absolute right-2 top-2 h-2 w-2 rounded-full bg-mint"
            />
          )}
        </button>
      </div>

      {/* Segmented control */}
      <div className="border-b border-cream-line bg-cream px-3 py-2 sm:px-4">
        <PlayersMatchesToggle current="players" />
      </div>

      {/* Filter row */}
      {filtersOpen && (
        <FilterBar
          cities={cities}
          view={view}
          counts={counts}
          onChange={onFilterChange}
          canFilterMine={canFilterMine}
        />
      )}

      {/* Status line */}
      <div className="flex items-center justify-between gap-2 border-b border-cream-line bg-cream px-3 py-1 sm:px-4">
        <span className="text-[11px] text-deep-green/55">{countLabel}</span>
        <div className="flex items-center gap-2 text-[11px]">
          <span className="inline-flex items-center gap-1 text-deep-green/55">
            <span
              aria-hidden
              className={`inline-block h-1.5 w-1.5 rounded-full ${liveDot}`}
            />
            {liveLabel}
          </span>
          <EnablePushNotificationsButton />
          <button
            type="button"
            onClick={onRefresh}
            style={{ touchAction: "manipulation" }}
            className="rounded-full px-2 py-0.5 text-[11px] font-medium text-deep-green/70 transition hover:bg-cream-soft hover:text-deep-green"
          >
            Refresh
          </button>
        </div>
      </div>
    </header>
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
}: {
  selectedId: string;
  detail: ThreadDetail | null;
  error: string | null;
  loading: boolean;
  appUserId: string | null;
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
      />
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto overflow-x-hidden bg-cream px-3 py-3 sm:px-4"
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
        channel={channel}
        whatsappWindowExpired={whatsappWindowExpired}
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

  // Close needs a confirm step (it removes the thread from the Open
  // inbox); reopen is a direct, low-stakes action.
  const [confirmClose, setConfirmClose] = useState(false);

  if (!detail) {
    return (
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-cream-line bg-white px-2 sm:px-4">
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
    <div className="flex h-14 shrink-0 items-center gap-2 border-b border-cream-line bg-white px-1 sm:px-3">
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
                <span
                  title="Phone has historical accounts on file — showing the most recent"
                  className="inline-flex items-center gap-0.5 rounded-full bg-muted-soft px-1.5 py-px font-medium text-muted"
                >
                  <span aria-hidden>ⓘ</span> historical
                </span>
              </>
            )}
          </div>
        </div>
      </div>
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
      {/* Close / Reopen — ticket workflow. Admin-only (city managers
          can view but not action). Close confirms first (it drops the
          thread from the Open inbox); Reopen is a direct action. */}
      {canManageStatus &&
        (threadStatus === "open" ? (
          <button
            type="button"
            onClick={() => setConfirmClose(true)}
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
      <ConfirmCloseDialog
        open={confirmClose}
        onCancel={() => setConfirmClose(false)}
        onConfirm={() => {
          setConfirmClose(false);
          onSetStatus("close");
        }}
      />
    </div>
  );
}

// ============================================================
// Close-conversation confirm dialog. Styled to match
// ConfirmDeleteDialog but with close-specific, non-destructive copy
// (deep-green confirm, not coral — closing is reversible).
// ============================================================
function ConfirmCloseDialog({
  open,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-deep-green/30 px-4 py-12 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        className="w-full max-w-md rounded-2xl border border-cream-line bg-white p-6 shadow-xl shadow-deep-green/30"
      >
        <h2 className="font-display text-2xl uppercase leading-none tracking-tight text-deep-green">
          Close conversation
        </h2>
        <div className="mt-4 rounded-md border border-cream-line bg-cream-soft/40 p-3 text-sm text-deep-green">
          It will be removed from the Open inbox and can be reopened from
          Closed. A new reply from the player reopens it automatically.
        </div>
        <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-full border border-cream-line bg-transparent px-4 py-2 text-xs font-bold text-deep-green hover:bg-cream-soft"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-full bg-deep-green px-5 py-2 text-xs font-bold text-cream transition hover:bg-deep-green-soft"
          >
            Close conversation
          </button>
        </div>
      </div>
    </div>
  );
}

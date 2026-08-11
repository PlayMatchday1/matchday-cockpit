"use client";

// Phase 19 Step 2 B1 — the CRM conversation/inbox DATA LAYER, lifted out of CrmClient (2,364
// lines) into a provider MOUNTED IN match-ops/layout.tsx, which does not remount between Match
// Ops routes. This is the prerequisite for the docked chat: the data (threads, the open
// conversation, selection) has to survive navigation, which it can't while it lives in the
// route-local CrmClient.
//
// B1 moves the STATE, the LOADERS and SELECTION here; CrmClient consumes them via
// useCrmConversation() and its ~15 setThreads call sites go through the provider's setters. The
// realtime SUBSCRIPTION stays in CrmClient for this commit (its handlers now write through these
// setters); relocating the channel is B2. Bodies are unchanged from CrmClient — this is a
// relocation, not a rewrite. Selection comes OFF the URL: it is useState initialised once from
// ?threadId for deep links (was searchParams.get / router.replace).

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/useAuth";
import { isFreshThreadUpdate, nextWaitingSince } from "@/lib/awaitingReply";
import { type Assignee } from "@/components/AssigneeChip";
import { type CrmChannel } from "@/components/ChannelChip";
import type { DeliveryStatus } from "@/components/DeliveryStatusLabel";
import { type StatusFilter, type ViewCounts } from "@/app/(internal)/match-ops/player-chats/components/FilterBar";

// ---------------- shared types (moved verbatim from CrmClient; imported back there) ----------------

export type ThreadListRow = {
  id: string;
  phone_number: string;
  player_id: number | null;
  match_ambiguous: boolean;
  last_message_at: string;
  last_message_preview: string | null;
  last_message_direction: "inbound" | "outbound" | null;
  last_message_is_template: boolean;
  created_at: string;
  assigned_to_user_id: string | null;
  assigned_at: string | null;
  channel: CrmChannel;
  status: "open" | "closed";
  closed_at: string | null;
  closed_by_user_id: string | null;
  no_reply_needed_at: string | null;
  is_unread: boolean;
  is_follow_up: boolean;
  waiting_since: string | null;
  player: {
    first_name: string | null;
    last_name: string | null;
    preferable_city_normalized: string | null;
    is_member?: boolean | null;
  } | null;
  assignee: Assignee | null;
};

export type Message = {
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
  template_name?: string | null;
  is_auto_reply?: boolean;
  sender?: { email: string; full_name: string | null } | null;
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

export type ThreadDetail = {
  thread: ThreadListRow;
  messages: Message[];
  assignee: Assignee | null;
  latest_inbound_at: string | null;
};

// ---------------- helpers (moved from CrmClient; bearerHeaders imported back there) ----------------

export async function bearerHeaders(): Promise<Record<string, string> | null> {
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
export async function markThreadRead(threadId: string): Promise<void> {
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

function readViewParam(raw: string | null): StatusFilter {
  if (raw === "mine" || raw === "starred" || raw === "closed" || raw === "awaiting") return raw;
  return "open";
}

// ---------------- the context ----------------

export type CrmConversationValue = {
  // inbox list
  threads: ThreadListRow[];
  setThreads: React.Dispatch<React.SetStateAction<ThreadListRow[]>>;
  threadsError: string | null;
  setThreadsError: React.Dispatch<React.SetStateAction<string | null>>;
  threadsLoading: boolean;
  setThreadsLoading: React.Dispatch<React.SetStateAction<boolean>>;
  counts: ViewCounts;
  setCounts: React.Dispatch<React.SetStateAction<ViewCounts>>;
  // operators (assignee dropdown + realtime merge)
  operators: Assignee[];
  setOperators: React.Dispatch<React.SetStateAction<Assignee[]>>;
  operatorsById: Map<string, Assignee>;
  // the conversations map — every loaded ThreadDetail keyed by thread id. Both the Chats pane
  // (selectedThreadId) and the dock (dockedThreadId) index into this ONE map (Step 3a item 1).
  conversations: Record<string, ThreadDetail>;
  // the open conversation — DERIVED: conversations[selectedThreadId] ?? null.
  detail: ThreadDetail | null;
  // back-compat optimistic setter for the OPEN conversation; setDetail(null) clears the selection
  // and leaves the map alone (the dock may point at the same thread).
  setDetail: React.Dispatch<React.SetStateAction<ThreadDetail | null>>;
  detailError: string | null;
  setDetailError: React.Dispatch<React.SetStateAction<string | null>>;
  detailLoading: boolean;
  setDetailLoading: React.Dispatch<React.SetStateAction<boolean>>;
  realtimeOk: boolean | null;
  setRealtimeOk: React.Dispatch<React.SetStateAction<boolean | null>>;
  // selection (OFF the url — useState in the core atom, init once from ?threadId)
  selectedThreadId: string | null;
  selectThread: (id: string | null) => void;
  // the docked conversation (Phase 19). dockThread loads it into the map; undockThread clears it.
  dockedThreadId: string | null;
  dockThread: (id: string) => void;
  undockThread: () => void;
  dockOpen: boolean;
  setDockOpen: React.Dispatch<React.SetStateAction<boolean>>;
  // the active status view (URL-derived) + a stable ref the loaders read
  view: StatusFilter;
  viewRef: React.MutableRefObject<StatusFilter>;
  // shared 30s clock for the inbox's first-response cues
  nowMs: number;
  // loaders
  loadThreads: () => Promise<void>;
  loadDetail: (threadId: string) => Promise<void>;
  loadOperators: () => Promise<void>;
  scheduleReload: () => void;
  refreshDetailForMediaInsert: (threadId: string) => Promise<void>;
  onSent: (msg: Message) => void;
};

const CrmConversationContext = createContext<CrmConversationValue | null>(null);

export function useCrmConversation(): CrmConversationValue {
  const ctx = useContext(CrmConversationContext);
  if (!ctx) throw new Error("useCrmConversation must be used within CrmConversationProvider");
  return ctx;
}

const ZERO_COUNTS: ViewCounts = { open: 0, mine: 0, starred: 0, closed: 0, awaiting: 0 };

export function CrmConversationProvider({ children }: { children: ReactNode }) {
  const searchParams = useSearchParams();
  const { appUser } = useAuth(); // for the crm_thread_reads realtime filter (subscription below)

  // --------- inbox list state ---------
  const [threads, setThreads] = useState<ThreadListRow[]>([]);
  const [threadsError, setThreadsError] = useState<string | null>(null);
  const [threadsLoading, setThreadsLoading] = useState(true);
  const [counts, setCounts] = useState<ViewCounts>(ZERO_COUNTS);

  // --------- one shared 30s clock (re-renders rows from timestamps; no refetch) ---------
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  // --------- the active view (URL-derived) + a stable ref the loaders read ---------
  const view = useMemo<StatusFilter>(() => readViewParam(searchParams.get("view")), [searchParams]);
  // viewRef is updated during RENDER, deliberately — and it CANNOT move to an effect (B2 item 2).
  // Its reader is loadThreads, which is triggered by the view-change EFFECT that stays in the child
  // CrmClient (an orchestration effect, per B1). Child effects run BEFORE this parent provider's
  // effects, so a viewRef written in a parent effect would be stale when the child's loadThreads
  // reads it. Updating it in render keeps it current before any effect fires. (Selection no longer
  // needs a ref at all: it lives in the `core` atom below, and the subscription handlers read it
  // straight out of the functional-updater snapshot — Step 3a amendment 1.)
  const viewRef = useRef<StatusFilter>(view);
  viewRef.current = view;

  // --------- operators ---------
  const [operators, setOperators] = useState<Assignee[]>([]);
  const operatorsById = useMemo(() => new Map(operators.map((o) => [o.id, o])), [operators]);

  // --------- conversations map (Phase 19 Step 3a item 1) ---------
  // ONE state ATOM holding the conversations map AND selectedThreadId together (amendment 1), so a
  // functional updater always reads the id from the SAME snapshot as the map — no ref, and none of
  // the child-effect-before-parent-effect ordering hazard that kept viewRef in the render body.
  // Both selectedThreadId (Chats screen) and dockedThreadId (the dock) index into conversations, so
  // a thread appended once is seen by every view — no second slot, no double-append. Selection is
  // OFF the URL: initialised once from ?threadId (deep link), then state.
  const [core, setCore] = useState<{ conversations: Record<string, ThreadDetail>; selectedThreadId: string | null }>(
    () => ({ conversations: {}, selectedThreadId: searchParams.get("threadId") }),
  );
  const { conversations, selectedThreadId } = core;
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [realtimeOk, setRealtimeOk] = useState<boolean | null>(null);

  // The OPEN conversation for the Chats screen — DERIVED from the map, so CrmClient's `detail` is
  // byte-identical to before (still one ThreadDetail | null).
  const detail = selectedThreadId ? conversations[selectedThreadId] ?? null : null;

  const selectThread = useCallback(
    (id: string | null) => setCore((s) => ({ ...s, selectedThreadId: id })),
    [],
  );

  // Back-compat setDetail for CrmClient's optimistic updates to the OPEN conversation. Routes into
  // conversations[selectedThreadId], reading the id from the SAME atom (amendment 1 — no ref).
  // setDetail(null) means "no conversation open": it CLEARS selectedThreadId and LEAVES THE MAP
  // ALONE — never delete conversations[id], because the dock may point at that same thread.
  const setDetail = useCallback((update: React.SetStateAction<ThreadDetail | null>) => {
    setCore((s) => {
      const id = s.selectedThreadId;
      if (id == null) return s;
      const cur = s.conversations[id] ?? null;
      const next =
        typeof update === "function"
          ? (update as (p: ThreadDetail | null) => ThreadDetail | null)(cur)
          : update;
      if (next == null) return { ...s, selectedThreadId: null };
      return { ...s, conversations: { ...s.conversations, [id]: next } };
    });
  }, []);

  // --------- dock state (carried into commit A per amendment 3; the UI + sessionStorage are B) ---------
  const [dockedThreadId, setDockedThreadId] = useState<string | null>(null);
  const [dockOpen, setDockOpen] = useState<boolean>(true);

  // Mirror the selection into the URL so a refresh reopens the thread and deep links keep working —
  // but the PROVIDER stays the source of truth (selection is state, read from ?threadId only once
  // at mount). This uses window.history.replaceState, NOT router.replace/push: those go through
  // Next navigation, which is exactly what a persistent provider must avoid. replaceState updates
  // the address bar with no navigation and no history entry — switching threads is not navigation,
  // so back/forward must not stack it. Only ?threadId is touched; other params are preserved.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const cur = url.searchParams.get("threadId");
    if (cur === selectedThreadId) return; // already in sync (incl. the deep-link init case)
    if (selectedThreadId == null) url.searchParams.delete("threadId");
    else url.searchParams.set("threadId", selectedThreadId);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}`);
  }, [selectedThreadId]);

  // --------- fetchers (bodies unchanged from CrmClient) ---------
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
      };
      setThreads(j.threads);
      if (j.counts) setCounts(j.counts);
    } catch (err) {
      setThreadsError(err instanceof Error ? err.message : String(err));
    } finally {
      setThreadsLoading(false);
    }
  }, []);

  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleReload = useCallback(() => {
    if (reloadTimer.current) clearTimeout(reloadTimer.current);
    reloadTimer.current = setTimeout(() => {
      void loadThreads();
    }, 300);
  }, [loadThreads]);
  useEffect(
    () => () => {
      if (reloadTimer.current) clearTimeout(reloadTimer.current);
    },
    [],
  );

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
      // Write the loaded conversation straight into the map by its OWN id (not selectedThreadId):
      // by the time this async fetch resolves the selection may have moved on, and a docked thread
      // loads into the same map. A load ERROR does NOT clear the selection — it surfaces detailError
      // for the still-selected thread (setDetail(null) here would wrongly deselect).
      setCore((s) => ({ ...s, conversations: { ...s.conversations, [threadId]: j } }));
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : String(err));
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const refreshDetailForMediaInsert = useCallback(
    async (threadId: string): Promise<void> => {
      const headers = await bearerHeaders();
      if (!headers) return;
      try {
        const res = await fetch(`/api/crm/threads/${threadId}`, { headers });
        if (!res.ok) return;
        const j = (await res.json()) as ThreadDetail;
        // Only apply if the thread is STILL in the map (selected or docked) — if it was
        // deselected/undocked mid-fetch, drop the refresh rather than re-adding a stale entry.
        setCore((s) =>
          s.conversations[threadId]
            ? { ...s, conversations: { ...s.conversations, [threadId]: j } }
            : s,
        );
      } catch {
        /* Silent best-effort. */
      }
    },
    [],
  );

  const onSent = useCallback((msg: Message) => {
    // Append to whichever conversation the message belongs to (by thread_id), if it is in the map.
    setCore((s) => {
      const c = s.conversations[msg.thread_id];
      if (!c) return s;
      if (c.messages.some((m) => m.id === msg.id)) return s;
      return {
        ...s,
        conversations: { ...s.conversations, [msg.thread_id]: { ...c, messages: [...c.messages, msg] } },
      };
    });
    setThreads((prev) =>
      prev.map((t) =>
        t.id === msg.thread_id
          ? {
              ...t,
              last_message_at: msg.sent_at,
              last_message_preview: msg.body.slice(0, 80),
              last_message_direction: "outbound",
              last_message_is_template: false,
            }
          : t,
      ),
    );
  }, []);

  // Dock a thread (commit A defines the machinery; commit B renders the UI that calls it). Loads
  // the conversation into the map if it is not already there — the dock reads the SAME map slot as
  // the Chats pane, so a thread that is both open and docked is stored, appended, and patched once.
  const dockThread = useCallback(
    (id: string) => {
      setDockedThreadId(id);
      setDockOpen(true);
      setCore((s) => {
        if (s.conversations[id]) return s; // already loaded — reuse, don't refetch
        void loadDetail(id);
        return s;
      });
    },
    [loadDetail],
  );
  const undockThread = useCallback(() => setDockedThreadId(null), []);

  // --------- realtime (B2: moved here from CrmClient — one channel, five handlers, now mounted
  // in the persistent provider so messages keep arriving while navigated away). Bodies unchanged;
  // handlers write through the provider's own setters/refs. ---------
  useEffect(() => {
    const channel = supabase
      .channel("crm-stream-v2")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "crm_messages" },
        (payload) => {
          const m = payload.new as Message;
          // Append to ANY loaded conversation this message belongs to — selected OR docked — keyed
          // on thread_id, dedup on message id. (Was `=== selectedRef.current`; the map generalises
          // it so a docked thread paints the same inbound the open one would.)
          if (m.media_kind) {
            // media rows arrive without their signed URL — refetch fills it in (map-guarded).
            console.debug(
              `[crm:realtime] media INSERT, refetching thread=${m.thread_id} kind=${m.media_kind}`,
            );
            void refreshDetailForMediaInsert(m.thread_id);
          } else {
            setCore((s) => {
              const c = s.conversations[m.thread_id];
              if (!c) return s;
              if (c.messages.some((x) => x.id === m.id)) return s;
              return {
                ...s,
                conversations: { ...s.conversations, [m.thread_id]: { ...c, messages: [...c.messages, m] } },
              };
            });
          }
          // The out-of-hours auto-reply is intentionally invisible to the inbox row's state.
          if (!m.is_auto_reply) {
            setThreads((prev) =>
              prev.map((t) =>
                t.id === m.thread_id
                  ? {
                      ...t,
                      last_message_at: m.sent_at,
                      last_message_preview: m.body.slice(0, 80),
                      last_message_direction: m.direction,
                      last_message_is_template:
                        m.direction === "outbound" && !!m.template_name,
                      waiting_since: nextWaitingSince(t, {
                        direction: m.direction,
                        sentAt: m.sent_at,
                      }),
                    }
                  : t,
              ),
            );
          }
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "crm_messages" },
        (payload) => {
          const m = payload.new as Message;
          // Patch the message in whichever loaded conversation holds it (selected or docked).
          setCore((s) => {
            const c = s.conversations[m.thread_id];
            if (!c) return s;
            const i = c.messages.findIndex((x) => x.id === m.id);
            if (i === -1) return s;
            const merged: Message = { ...c.messages[i], ...m };
            const next = c.messages.slice();
            next[i] = merged;
            return {
              ...s,
              conversations: { ...s.conversations, [m.thread_id]: { ...c, messages: next } },
            };
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
              scheduleReload();
              return prev;
            }
            if ((exists.status ?? "open") !== (t.status ?? "open")) {
              scheduleReload();
              return prev;
            }
            if (!isFreshThreadUpdate(exists.last_message_at, t.last_message_at)) {
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
                    no_reply_needed_at:
                      "no_reply_needed_at" in t
                        ? t.no_reply_needed_at
                        : x.no_reply_needed_at,
                    assignee:
                      t.assigned_to_user_id != null
                        ? operatorsById.get(t.assigned_to_user_id) ??
                          x.assignee
                        : null,
                  }
                : x,
            );
          });
          // Patch the loaded conversation's header for this thread if it is in the map (selected or
          // docked) — so the dock's identity banner tracks reassignment/close the same as the pane.
          setCore((s) => {
            const c = s.conversations[t.id];
            if (!c) return s;
            return {
              ...s,
              conversations: {
                ...s.conversations,
                [t.id]: {
                  ...c,
                  thread: { ...c.thread, ...t },
                  assignee:
                    t.assigned_to_user_id != null
                      ? operatorsById.get(t.assigned_to_user_id) ?? c.assignee
                      : null,
                },
              },
            };
          });
        },
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "crm_threads" },
        () => {
          scheduleReload();
        },
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "crm_thread_reads",
          filter: appUser?.id ? `user_id=eq.${appUser.id}` : undefined,
        },
        () => {
          scheduleReload();
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
  }, [scheduleReload, operatorsById, refreshDetailForMediaInsert, appUser?.id]);

  const value: CrmConversationValue = {
    threads, setThreads, threadsError, setThreadsError, threadsLoading, setThreadsLoading,
    counts, setCounts, operators, setOperators, operatorsById,
    conversations, detail, setDetail, detailError, setDetailError, detailLoading, setDetailLoading, realtimeOk, setRealtimeOk,
    selectedThreadId, selectThread, view, viewRef, nowMs,
    dockedThreadId, dockThread, undockThread, dockOpen, setDockOpen,
    loadThreads, loadDetail, loadOperators, scheduleReload, refreshDetailForMediaInsert, onSent,
  };

  return <CrmConversationContext.Provider value={value}>{children}</CrmConversationContext.Provider>;
}

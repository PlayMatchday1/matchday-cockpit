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
  // the open conversation
  detail: ThreadDetail | null;
  setDetail: React.Dispatch<React.SetStateAction<ThreadDetail | null>>;
  detailError: string | null;
  setDetailError: React.Dispatch<React.SetStateAction<string | null>>;
  detailLoading: boolean;
  setDetailLoading: React.Dispatch<React.SetStateAction<boolean>>;
  realtimeOk: boolean | null;
  setRealtimeOk: React.Dispatch<React.SetStateAction<boolean | null>>;
  // selection (OFF the url — useState, init once from ?threadId)
  selectedThreadId: string | null;
  selectThread: (id: string | null) => void;
  selectedRef: React.MutableRefObject<string | null>;
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
  // viewRef is updated during RENDER (not in an effect) so it is already current before ANY
  // effect runs — the loadThreads trigger effect lives in the child CrmClient, whose effects run
  // BEFORE this parent provider's effects; a ref updated in a parent effect would be stale. This
  // preserves the original single-component ordering (viewRef set before loadThreads reads it).
  const viewRef = useRef<StatusFilter>(view);
  viewRef.current = view;

  // --------- operators ---------
  const [operators, setOperators] = useState<Assignee[]>([]);
  const operatorsById = useMemo(() => new Map(operators.map((o) => [o.id, o])), [operators]);

  // --------- the open conversation ---------
  const [detail, setDetail] = useState<ThreadDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [realtimeOk, setRealtimeOk] = useState<boolean | null>(null);

  // --------- selection, OFF the url: init once from ?threadId (deep links), then state ---------
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(
    () => searchParams.get("threadId"),
  );
  const selectThread = useCallback((id: string | null) => setSelectedThreadId(id), []);
  // Latest-value ref for the subscription handlers (which read selectedRef.current at event time).
  const selectedRef = useRef<string | null>(selectedThreadId);
  selectedRef.current = selectedThreadId;

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
      setDetail(j);
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : String(err));
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }, []);

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
        /* Silent best-effort. */
      }
    },
    [],
  );

  const onSent = useCallback((msg: Message) => {
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
              last_message_direction: "outbound",
              last_message_is_template: false,
            }
          : t,
      ),
    );
  }, []);

  const value: CrmConversationValue = {
    threads, setThreads, threadsError, setThreadsError, threadsLoading, setThreadsLoading,
    counts, setCounts, operators, setOperators, operatorsById,
    detail, setDetail, detailError, setDetailError, detailLoading, setDetailLoading, realtimeOk, setRealtimeOk,
    selectedThreadId, selectThread, selectedRef, view, viewRef, nowMs,
    loadThreads, loadDetail, loadOperators, scheduleReload, refreshDetailForMediaInsert, onSent,
  };

  return <CrmConversationContext.Provider value={value}>{children}</CrmConversationContext.Provider>;
}

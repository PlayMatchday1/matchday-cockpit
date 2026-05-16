"use client";

// Player Chat — three-pane desktop / single-pane mobile layout.
// Replaces the old "CRM" page UI; the underlying data layer, route
// (/crm), and DB tables (crm_threads, crm_messages) are unchanged.
//
// Composition:
//
//   Top of page (rendered by /crm/page.tsx)
//     <CrmSubTabStrip />     ← Player Chat / Match Chats
//
//   This component (CrmClient)
//     <FilterBar />          ← assignment + city filters
//     ┌──────────────┬───────────────────┬──────────────┐
//     │ InboxPane    │ ConversationPane  │ ContextPanel │
//     │ (240px on    │ (flex-1)          │ (240px on    │
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
//   ?status=mine  — assignment filter (omitted when "all")
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
import { ChevronLeft, Info } from "lucide-react";
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
} from "./components/FilterBar";
import InboxRow, { type InboxRowThread } from "./components/InboxRow";
import AssignDropdown from "./components/AssignDropdown";
import MessageBubble, {
  type ConversationMessage,
} from "./components/MessageBubble";
import Composer from "./components/Composer";
import ContextPanel, {
  type ContextPlayer,
  type ContextRecentMatch,
} from "./components/ContextPanel";

// ---------------- shared types ----------------

type ThreadListRow = {
  id: string;
  phone_number: string;
  player_id: number | null;
  match_ambiguous: boolean;
  last_message_at: string;
  last_message_preview: string | null;
  created_at: string;
  assigned_to_user_id: string | null;
  assigned_at: string | null;
  channel: CrmChannel;
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
};

type RecentMatch = ContextRecentMatch;

type ThreadDetail = {
  thread: ThreadListRow;
  messages: Message[];
  player: ContextPlayer | null;
  assignee: Assignee | null;
  recent_matches: RecentMatch[];
  historical_account_count: number | null;
  latest_inbound_at: string | null;
};

// ---------------- constants ----------------

const LAST_VIEWED_KEY = "crm:lastViewed:v1";
const WHATSAPP_WINDOW_MS = 24 * 60 * 60 * 1000;

// ---------------- helpers ----------------

function readJson<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as T;
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJson<T>(key: string, value: T): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode etc — silent */
  }
}

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

  const statusFilter = useMemo<StatusFilter>(() => {
    const raw = searchParams.get("status");
    if (raw === "unassigned" || raw === "mine") return raw;
    return "all";
  }, [searchParams]);

  const selectedId = searchParams.get("threadId");

  const setFilters = useCallback(
    (next: { cities?: Set<string>; status?: StatusFilter }) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next.cities !== undefined) {
        if (next.cities.size === 0) params.delete("cities");
        else params.set("cities", [...next.cities].join(","));
      }
      if (next.status !== undefined) {
        if (next.status === "all") params.delete("status");
        else params.set("status", next.status);
      }
      const qs = params.toString();
      router.replace(qs ? `/crm?${qs}` : "/crm", { scroll: false });
    },
    [router, searchParams],
  );

  const setSelected = useCallback(
    (id: string | null) => {
      const params = new URLSearchParams(searchParams.toString());
      if (id == null) params.delete("threadId");
      else params.set("threadId", id);
      const qs = params.toString();
      router.replace(qs ? `/crm?${qs}` : "/crm", { scroll: false });
    },
    [router, searchParams],
  );

  // --------- data state ---------
  const [threads, setThreads] = useState<ThreadListRow[]>([]);
  const [threadsError, setThreadsError] = useState<string | null>(null);
  const [threadsLoading, setThreadsLoading] = useState(true);

  const [operators, setOperators] = useState<Assignee[]>([]);
  const operatorsById = useMemo(
    () => new Map(operators.map((o) => [o.id, o])),
    [operators],
  );

  const [detail, setDetail] = useState<ThreadDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [lastViewed, setLastViewed] = useState<Record<string, string>>({});
  const [realtimeOk, setRealtimeOk] = useState<boolean | null>(null);

  // Mobile context-panel sheet open/close. Desktop ignores this —
  // the column variant is always visible at lg: + above.
  const [contextSheetOpen, setContextSheetOpen] = useState(false);

  useEffect(() => {
    setLastViewed(readJson<Record<string, string>>(LAST_VIEWED_KEY, {}));
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
      const res = await fetch("/api/crm/threads", { headers });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      const j = (await res.json()) as { threads: ThreadListRow[] };
      setThreads(j.threads);
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

  useEffect(() => {
    void loadThreads();
    void loadOperators();
  }, [loadThreads, loadOperators]);

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
    setLastViewed((prev) => {
      const next = { ...prev, [selectedId]: new Date().toISOString() };
      writeJson(LAST_VIEWED_KEY, next);
      return next;
    });
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
            setDetail((prev) => {
              if (!prev) return prev;
              if (prev.messages.some((x) => x.id === m.id)) return prev;
              return { ...prev, messages: [...prev.messages, m] };
            });
          }
          setThreads((prev) =>
            prev.map((t) =>
              t.id === m.thread_id
                ? {
                    ...t,
                    last_message_at: m.sent_at,
                    last_message_preview: m.body.slice(0, 80),
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
  }, [loadThreads, operatorsById]);

  // --------- derived list ---------
  const filteredThreads = useMemo(() => {
    const arr = [...threads].sort(
      (a, b) =>
        Date.parse(b.last_message_at) - Date.parse(a.last_message_at),
    );
    return arr
      .filter((t) => {
        if (cityFilter.size > 0) {
          const code = cityCodeForThread(t);
          if (!cityFilter.has(code)) return false;
        }
        if (statusFilter === "unassigned" && t.assigned_to_user_id != null)
          return false;
        if (statusFilter === "mine") {
          if (!appUser?.id) return false;
          if (t.assigned_to_user_id !== appUser.id) return false;
        }
        return true;
      })
      .map((t) => {
        const seenAt = lastViewed[t.id];
        const unread =
          !!t.last_message_preview &&
          (seenAt == null ||
            Date.parse(t.last_message_at) > Date.parse(seenAt));
        return { ...t, unread };
      });
  }, [threads, lastViewed, cityFilter, statusFilter, appUser?.id]);

  const selectedThread =
    filteredThreads.find((t) => t.id === selectedId) ??
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
      } catch (err) {
        console.error("[crm] assign failed", err);
      }
    },
    [],
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
              }
            : t,
        ),
      );
    },
    [],
  );

  const whatsappExpired = computeWhatsAppExpired(detail);
  const supabaseProjectRef =
    process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(
      /^https:\/\/([^.]+)\..*/,
      "$1",
    ) ?? null;

  // Mobile flow rules:
  //   no selectedId             → inbox full-screen
  //   selectedId on mobile      → conversation full-screen + back arrow
  //   selectedId on desktop     → both panes side-by-side
  // Implemented via Tailwind responsive `hidden lg:flex` rather than
  // JS branching so the layout doesn't reflow on viewport change.
  const showInboxMobile = !selectedId;
  const showConversationMobile = !!selectedId;

  return (
    <div className="flex h-[calc(100vh-7rem)] flex-col bg-cream sm:h-[calc(100vh-7.5rem)]">
      {/* Header strip: status pill + active-filter summary. Kept tiny
          so the inbox + conversation get every available pixel. */}
      <PageStatusBar
        loading={threadsLoading}
        total={threads.length}
        visible={filteredThreads.length}
        realtimeOk={realtimeOk}
        onRefresh={() => void loadThreads()}
      />

      <div className="flex min-h-0 flex-1">
        {/* --- LEFT PANE: inbox + filter bar --- */}
        <aside
          className={`flex-col border-r border-cream-line bg-white lg:flex lg:w-[280px] lg:shrink-0 ${
            showInboxMobile ? "flex flex-1" : "hidden lg:flex"
          }`}
        >
          <FilterBar
            cities={cityFilter}
            status={statusFilter}
            onChange={setFilters}
            canFilterMine={!!appUser?.id}
          />
          <div className="flex-1 overflow-y-auto">
            {threadsError && (
              <div className="m-2 rounded border border-coral/40 bg-coral-soft p-2 text-xs text-coral-hover">
                {threadsError}
              </div>
            )}
            {threadsLoading && filteredThreads.length === 0 && (
              <InboxSkeleton />
            )}
            {!threadsLoading &&
              filteredThreads.length === 0 &&
              !threadsError && (
                <div className="p-4 text-xs text-deep-green/45">
                  No conversations match the current filters.
                </div>
              )}
            <ul className="divide-y divide-cream-line">
              {filteredThreads.map((t) => (
                <InboxRow
                  key={t.id}
                  thread={t as InboxRowThread}
                  active={t.id === selectedId}
                  onSelect={() => setSelected(t.id)}
                />
              ))}
            </ul>
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
              whatsappWindowExpired={whatsappExpired}
            />
          )}
        </section>

        {/* --- RIGHT PANE: context (desktop column) --- */}
        <ContextPanel
          mode="column"
          open={false}
          thread={
            selectedThread
              ? {
                  phone_number: selectedThread.phone_number,
                  match_ambiguous: selectedThread.match_ambiguous,
                }
              : null
          }
          player={detail?.player ?? null}
          recentMatches={detail?.recent_matches ?? []}
          historicalAccountCount={detail?.historical_account_count ?? null}
          supabaseProjectRef={supabaseProjectRef}
          loading={detailLoading}
        />
      </div>

      {/* Mobile context sheet — only mounted under lg:. Always present
          so the slide-up transition has a target; visibility gated
          by `open`. */}
      <ContextPanel
        mode="sheet"
        open={contextSheetOpen}
        onClose={() => setContextSheetOpen(false)}
        thread={
          selectedThread
            ? {
                phone_number: selectedThread.phone_number,
                match_ambiguous: selectedThread.match_ambiguous,
              }
            : null
        }
        player={detail?.player ?? null}
        recentMatches={detail?.recent_matches ?? []}
        historicalAccountCount={detail?.historical_account_count ?? null}
        supabaseProjectRef={supabaseProjectRef}
        loading={detailLoading}
      />
    </div>
  );
}

// ============================================================
// Page status bar — tiny header strip
// ============================================================
function PageStatusBar({
  loading,
  total,
  visible,
  realtimeOk,
  onRefresh,
}: {
  loading: boolean;
  total: number;
  visible: number;
  realtimeOk: boolean | null;
  onRefresh: () => void;
}) {
  const filtered = visible !== total;
  const liveLabel =
    realtimeOk == null
      ? "connecting…"
      : realtimeOk
        ? "live"
        : "offline";
  const liveDot =
    realtimeOk == null
      ? "bg-muted"
      : realtimeOk
        ? "bg-mint"
        : "bg-coral";

  return (
    <div className="flex shrink-0 items-center justify-between gap-3 border-b border-cream-line bg-cream px-3 py-2 text-xs sm:px-4">
      <span className="text-deep-green/65">
        {loading
          ? "Loading…"
          : filtered
            ? `${visible} of ${total}`
            : `${total} conversation${total === 1 ? "" : "s"}`}
      </span>
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-deep-green/55">
          <span className={`inline-block h-2 w-2 rounded-full ${liveDot}`} />
          {liveLabel}
        </span>
        <button
          type="button"
          onClick={onRefresh}
          className="rounded-full border border-cream-line bg-white px-2.5 py-1 text-[11px] font-medium text-deep-green/75 transition hover:bg-cream-soft"
        >
          Refresh
        </button>
      </div>
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
  operators,
  onAssign,
  onSent,
  onBack,
  onOpenContext,
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
      />
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto bg-cream px-3 py-3 sm:px-4"
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
        <ul className="space-y-2.5">
          {messages.map((m) => (
            <MessageBubble key={m.id} msg={m as ConversationMessage} />
          ))}
        </ul>
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

function ConversationHeader({
  detail,
  operators,
  onAssign,
  onBack,
  onOpenContext,
}: {
  detail: ThreadDetail | null;
  operators: Assignee[];
  onAssign: (userId: string | null) => void;
  onBack: () => void;
  onOpenContext: () => void;
}) {
  if (!detail) {
    return (
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-cream-line bg-white px-3 sm:px-4">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to inbox"
          className="inline-flex h-9 w-9 items-center justify-center rounded-full text-deep-green/70 hover:bg-cream-soft hover:text-deep-green lg:hidden"
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
  const matchCount = detail.player?.total_match_count;
  return (
    <div className="flex h-14 shrink-0 items-center gap-2 border-b border-cream-line bg-white px-2 sm:px-3">
      <button
        type="button"
        onClick={onBack}
        aria-label="Back to inbox"
        className="inline-flex h-9 w-9 items-center justify-center rounded-full text-deep-green/70 hover:bg-cream-soft hover:text-deep-green lg:hidden"
      >
        <ChevronLeft aria-hidden className="h-5 w-5" />
      </button>
      <PlayerAvatar
        name={name}
        seed={detail.thread.phone_number}
        channel={channel}
        size="sm"
        isMember={detail.player?.is_member === true}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-extrabold tracking-tight text-deep-green">
          {name}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-deep-green/55">
          <CityChip code={cityCode} />
          <span aria-hidden>·</span>
          <span className="inline-flex items-center gap-0.5">
            <ChannelChip channel={channel} />
            via {channelDisplay(channel)}
          </span>
          {typeof matchCount === "number" && (
            <>
              <span aria-hidden>·</span>
              <span>{matchCount} matches</span>
            </>
          )}
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
      <button
        type="button"
        onClick={onOpenContext}
        aria-label="Player context"
        className="inline-flex h-9 w-9 items-center justify-center rounded-full text-deep-green/70 hover:bg-cream-soft hover:text-deep-green lg:hidden"
      >
        <Info aria-hidden className="h-4 w-4" />
      </button>
    </div>
  );
}

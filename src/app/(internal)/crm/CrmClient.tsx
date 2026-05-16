"use client";

// Phase 1 CRM — three-pane SMS console with assignment, city/status
// filters, and collapsible side panes. Builds on Phase 0.
//
//   Header        : PageHeader-aligned title + filter bar + status chip.
//   Left (260px)  : thread list. Per-row: name, preview, city+assignee
//                   chips, time-ago, unread dot. Collapsible to 40px.
//   Center        : empty state OR conversation. Header has the
//                   assignment dropdown. Composer same as Phase 0.
//   Right (240px) : player context card. Collapsible to 40px.
//
// State persistence:
//   - filters       → URL query params (?cities=…&status=…)
//   - pane collapse → localStorage (`crm:panes:v1`)
//   - per-thread last-viewed → localStorage (`crm:lastViewed:v1`)
//
// Realtime: subscribes to crm_messages INSERTs and crm_threads
// INSERT/UPDATEs; assignment changes broadcast via crm_threads UPDATE
// and are resolved locally against the cached operators list.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/useAuth";
import { KNOWN_CITY_CODES } from "@/lib/cityNormalization";
import { colorForCity, UNKNOWN_CITY } from "@/lib/cityColors";
import CityChip from "@/components/CityChip";
import AssigneeChip, { type Assignee } from "@/components/AssigneeChip";
import MatchStatusPill, {
  type MatchStatus,
} from "@/components/MatchStatusPill";
import ChannelChip, {
  channelDisplay,
  type CrmChannel,
} from "@/components/ChannelChip";
import { Check, CheckCheck } from "lucide-react";

// WhatsApp's 24-hour customer service window. Mirrored from
// /api/crm/send — the server enforces, the client just hides the
// composer + shows a muted hint when expired.
const WHATSAPP_WINDOW_MS = 24 * 60 * 60 * 1000;

// ---------------- types ----------------

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
  } | null;
  assignee: Assignee | null;
};

// Outbound delivery lifecycle. WhatsApp rides the full lane via the
// statuses[] branch of the Meta webhook; SMS stops at 'sent' or
// 'failed' (Telnyx delivery receipts are a Phase 2 follow-up).
// 'pending' is rarely observed in practice — the send route writes
// 'sent' on insert, so it only surfaces between optimistic UI ops
// (none today) and the server response.
type DeliveryStatus = "pending" | "sent" | "delivered" | "read" | "failed";

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

type PlayerContext = {
  id: number;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone_number: string | null;
  preferable_city_normalized: string | null;
  preferable_city_name: string | null;
  is_member: boolean | null;
  created_at: string | null;
  total_match_count: number | null;
};

type RecentMatch = {
  match_api_id: number;
  venue: string | null;
  start_date: string | null;
  status: MatchStatus;
};

type ThreadDetail = {
  thread: ThreadListRow;
  messages: Message[];
  player: PlayerContext | null;
  assignee: Assignee | null;
  recent_matches: RecentMatch[];
  historical_account_count: number | null;
  // ISO timestamp of the newest inbound message for this thread,
  // or null if no inbound exists yet. Used to evaluate the
  // WhatsApp 24-hour window client-side. SMS ignores this.
  latest_inbound_at: string | null;
};

type StatusFilter = "all" | "unassigned" | "mine";

// ---------------- constants ----------------

const ALL_CITY_CODES: readonly string[] = [...KNOWN_CITY_CODES, UNKNOWN_CITY];
const LAST_VIEWED_KEY = "crm:lastViewed:v1";
const PANES_KEY = "crm:panes:v1";

// ---------------- localStorage helpers ----------------

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
    // localStorage may be unavailable (e.g. private mode) — silently
    // degrade.
  }
}

// ---------------- display + formatting ----------------

function displayNameForThread(t: ThreadListRow): string {
  if (t.player) {
    const first = t.player.first_name?.trim() ?? "";
    const last = t.player.last_name?.trim() ?? "";
    const full = `${first} ${last}`.trim();
    if (full) return full;
  }
  return t.phone_number;
}

function cityCodeForThread(t: ThreadListRow): string {
  // "Unknown" covers both no matched player AND matched player whose
  // city is null. UI-side derivation per Phase 1 spec.
  const c = t.player?.preferable_city_normalized;
  return c && c.length > 0 ? c : UNKNOWN_CITY;
}

function timeAgo(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const diffSec = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (diffSec < 45) return "just now";
  if (diffSec < 90) return "1m";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m`;
  if (diffSec < 5400) return "1h";
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h`;
  if (diffSec < 172800) return "1d";
  if (diffSec < 604800) return `${Math.floor(diffSec / 86400)}d`;
  return new Date(then).toLocaleDateString();
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// GSM-7 detection — see CrmClient v0 for the rationale; unchanged.
const GSM7_RX =
  /^[\n\rA-Za-z0-9 @£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà€\\[\]{}|~^]*$/;

function smsBudget(body: string): {
  encoding: "gsm7" | "ucs2";
  segmentSize: number;
  segments: number;
} {
  const encoding = GSM7_RX.test(body) ? "gsm7" : "ucs2";
  const segmentSize = encoding === "gsm7" ? 160 : 70;
  const len = body.length;
  const segments = len === 0 ? 0 : Math.ceil(len / segmentSize);
  return { encoding, segmentSize, segments };
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

// ---------------- main ----------------

export default function CrmClient() {
  const { appUser } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();

  // -------- filter state synced to URL --------
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

  // -------- collapsible panes (localStorage) --------
  const [panes, setPanes] = useState<{ left: boolean; right: boolean }>({
    left: false,
    right: false,
  });
  useEffect(() => {
    setPanes(readJson(PANES_KEY, { left: false, right: false }));
  }, []);
  const updatePanes = useCallback(
    (patch: Partial<{ left: boolean; right: boolean }>) => {
      setPanes((prev) => {
        const next = { ...prev, ...patch };
        writeJson(PANES_KEY, next);
        return next;
      });
    },
    [],
  );

  // -------- data --------
  const [threads, setThreads] = useState<ThreadListRow[]>([]);
  const [threadsError, setThreadsError] = useState<string | null>(null);
  const [threadsLoading, setThreadsLoading] = useState(true);

  const [operators, setOperators] = useState<Assignee[]>([]);
  const operatorsById = useMemo(
    () => new Map(operators.map((o) => [o.id, o])),
    [operators],
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ThreadDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [lastViewed, setLastViewed] = useState<Record<string, string>>({});
  const [realtimeOk, setRealtimeOk] = useState<boolean | null>(null);

  useEffect(() => {
    setLastViewed(readJson<Record<string, string>>(LAST_VIEWED_KEY, {}));
  }, []);

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
      // non-fatal — dropdown will be empty.
    }
  }, []);

  useEffect(() => {
    void loadThreads();
    void loadOperators();
  }, [loadThreads, loadOperators]);

  // -------- detail --------
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

  const selectThread = useCallback(
    (id: string) => {
      setSelectedId(id);
      void loadDetail(id);
      setLastViewed((prev) => {
        const next = { ...prev, [id]: new Date().toISOString() };
        writeJson(LAST_VIEWED_KEY, next);
        return next;
      });
    },
    [loadDetail],
  );

  // -------- realtime --------
  const selectedRef = useRef<string | null>(null);
  useEffect(() => {
    selectedRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    const channel = supabase
      .channel("crm-stream-v1")
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
        // Delivery-status changes from the WhatsApp status webhook
        // come through as row UPDATEs. Merge the new fields into
        // whatever message is currently in state — no refetch
        // needed. Only the open thread's messages are visible, so
        // we only patch when thread_id matches.
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
                    // assignee is a join — resolve locally from the
                    // cached operators list. If the new id isn't in
                    // the cache (rare: a brand-new admin), the chip
                    // shows their initials as soon as loadOperators
                    // refreshes; the list refetch on focus is a
                    // backstop.
                    assignee:
                      t.assigned_to_user_id != null
                        ? operatorsById.get(t.assigned_to_user_id) ??
                          x.assignee
                        : null,
                  }
                : x,
            );
          });
          // Mirror into the open detail if applicable.
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

  // -------- derived: sorted + filtered + unread-flagged --------
  const filteredThreads = useMemo(() => {
    const arr = [...threads].sort(
      (a, b) => Date.parse(b.last_message_at) - Date.parse(a.last_message_at),
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

  // -------- assign handler --------
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
        // Optimistic local update; realtime UPDATE will arrive and
        // dedupe.
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

  return (
    <div className="-mx-6 -my-8 flex h-[calc(100vh-4rem)] flex-col bg-cream">
      <Header
        loading={threadsLoading}
        total={threads.length}
        visible={filteredThreads.length}
        realtimeOk={realtimeOk}
        onRefresh={() => void loadThreads()}
      />
      <FilterBar
        cities={cityFilter}
        status={statusFilter}
        onChange={setFilters}
        canFilterMine={!!appUser?.id}
      />

      <div className="flex min-h-0 flex-1">
        <ThreadListPane
          threads={filteredThreads}
          selectedId={selectedId}
          onSelect={selectThread}
          loading={threadsLoading}
          error={threadsError}
          collapsed={panes.left}
          onToggleCollapsed={() => updatePanes({ left: !panes.left })}
        />
        <ConversationPane
          detail={detail}
          loading={detailLoading}
          error={detailError}
          selectedId={selectedId}
          appUserId={appUser?.id ?? null}
          operators={operators}
          onAssign={onAssign}
          onSent={(msg) => {
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
          }}
        />
        <PlayerPane
          detail={detail}
          selectedThread={selectedThread}
          loading={detailLoading}
          collapsed={panes.right}
          onToggleCollapsed={() => updatePanes({ right: !panes.right })}
        />
      </div>
    </div>
  );
}

// ============================================================
// Header (page-level)
// ============================================================
function Header({
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
    <div className="border-b border-cream-line bg-cream px-6 py-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-deep-green">
            CRM
          </h1>
          <p className="mt-0.5 text-xs text-deep-green/60">
            {loading
              ? "Loading conversations…"
              : filtered
                ? `${visible} of ${total} conversation${total === 1 ? "" : "s"}`
                : `${total} conversation${total === 1 ? "" : "s"}`}
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs text-deep-green/70">
          <span className="inline-flex items-center gap-1.5">
            <span
              className={`inline-block h-2 w-2 rounded-full ${liveDot}`}
              aria-hidden
            />
            {liveLabel}
          </span>
          <button
            type="button"
            onClick={onRefresh}
            className="rounded-full border border-cream-line bg-white px-3 py-1 font-medium text-deep-green transition hover:bg-cream-soft"
          >
            Refresh
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// FilterBar (city chips + status segmented control)
// ============================================================
function FilterBar({
  cities,
  status,
  onChange,
  canFilterMine,
}: {
  cities: Set<string>;
  status: StatusFilter;
  onChange: (next: { cities?: Set<string>; status?: StatusFilter }) => void;
  canFilterMine: boolean;
}) {
  const allActive = cities.size === 0;

  const toggleCity = (code: string) => {
    const next = new Set(cities);
    if (allActive) {
      // First click out of "All" mode — start with just this city.
      onChange({ cities: new Set([code]) });
      return;
    }
    if (next.has(code)) next.delete(code);
    else next.add(code);
    onChange({ cities: next });
  };

  const setStatus = (s: StatusFilter) => onChange({ status: s });

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-cream-line bg-cream-soft px-6 py-3">
      <button
        type="button"
        onClick={() => onChange({ cities: new Set() })}
        className={`rounded-full px-2.5 py-0.5 text-xs font-medium transition ${
          allActive
            ? "bg-deep-green text-cream"
            : "border border-cream-line bg-white text-deep-green/70 hover:bg-cream-soft"
        }`}
      >
        All
      </button>
      {ALL_CITY_CODES.map((code) => {
        const active = !allActive && cities.has(code);
        const hex = colorForCity(code);
        return (
          <button
            key={code}
            type="button"
            onClick={() => toggleCity(code)}
            className={`rounded-full px-2.5 py-0.5 text-xs font-medium transition ${
              active
                ? "border border-transparent"
                : "border border-cream-line bg-white text-deep-green/70 hover:bg-cream-soft"
            }`}
            style={
              active
                ? { backgroundColor: hex + "26", color: hex, borderColor: hex + "55" }
                : undefined
            }
          >
            {code}
          </button>
        );
      })}

      <span aria-hidden className="mx-2 h-4 w-px bg-cream-line" />

      <SegmentedStatus
        value={status}
        onChange={setStatus}
        canFilterMine={canFilterMine}
      />
    </div>
  );
}

function SegmentedStatus({
  value,
  onChange,
  canFilterMine,
}: {
  value: StatusFilter;
  onChange: (s: StatusFilter) => void;
  canFilterMine: boolean;
}) {
  const opts: { val: StatusFilter; label: string; disabled?: boolean }[] = [
    { val: "all", label: "All" },
    { val: "unassigned", label: "Unassigned" },
    { val: "mine", label: "Mine", disabled: !canFilterMine },
  ];
  return (
    <div className="inline-flex overflow-hidden rounded-full border border-cream-line bg-white">
      {opts.map((o, i) => {
        const active = value === o.val;
        return (
          <button
            key={o.val}
            type="button"
            disabled={o.disabled}
            onClick={() => onChange(o.val)}
            className={`px-2.5 py-0.5 text-xs font-medium transition ${
              active
                ? "bg-deep-green text-cream"
                : "text-deep-green/70 hover:bg-cream-soft disabled:opacity-40"
            } ${i > 0 ? "border-l border-cream-line" : ""}`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// ============================================================
// Left pane
// ============================================================
function ThreadListPane({
  threads,
  selectedId,
  onSelect,
  loading,
  error,
  collapsed,
  onToggleCollapsed,
}: {
  threads: (ThreadListRow & { unread: boolean })[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  loading: boolean;
  error: string | null;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  return (
    <aside
      className="flex shrink-0 flex-col overflow-hidden border-r border-cream-line bg-cream-soft transition-[width] duration-200 ease-out"
      style={{ width: collapsed ? 40 : 280 }}
    >
      <div className="flex h-9 items-center justify-between border-b border-cream-line bg-cream-soft px-2">
        {!collapsed && (
          <span className="px-1 text-[11px] font-semibold uppercase tracking-wide text-deep-green/60">
            Inbox
          </span>
        )}
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-label={collapsed ? "Expand inbox" : "Collapse inbox"}
          className="ml-auto inline-flex h-6 w-6 items-center justify-center rounded text-deep-green/60 transition hover:bg-white hover:text-deep-green"
        >
          {collapsed ? "›" : "‹"}
        </button>
      </div>
      {collapsed ? (
        <button
          type="button"
          onClick={onToggleCollapsed}
          className="flex-1 text-[10px] uppercase tracking-widest text-deep-green/40 [writing-mode:vertical-rl]"
          aria-label="Expand inbox"
        >
          Inbox
        </button>
      ) : (
        <div className="flex-1 overflow-y-auto">
          {error && (
            <div className="m-2 rounded border border-coral/40 bg-coral-soft p-2 text-xs text-coral-hover">
              {error}
            </div>
          )}
          {loading && threads.length === 0 && (
            <div className="p-3 text-xs text-deep-green/50">Loading…</div>
          )}
          {!loading && threads.length === 0 && !error && (
            <EmptyState
              icon="🗨️"
              title="No conversations"
              subtitle="Text the Telnyx number to start one, or change the filters above."
            />
          )}
          <ul className="divide-y divide-cream-line">
            {threads.map((t) => (
              <ThreadRow
                key={t.id}
                t={t}
                active={t.id === selectedId}
                onSelect={() => onSelect(t.id)}
              />
            ))}
          </ul>
        </div>
      )}
    </aside>
  );
}

function ThreadRow({
  t,
  active,
  onSelect,
}: {
  t: ThreadListRow & { unread: boolean };
  active: boolean;
  onSelect: () => void;
}) {
  const name = displayNameForThread(t);
  const cityCode = cityCodeForThread(t);
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={`block w-full px-3 py-2.5 text-left transition ${
          active
            ? "bg-mint-soft"
            : "border-l-2 border-l-transparent hover:bg-white"
        } ${active ? "border-l-2 border-l-mint" : ""}`}
      >
        <div className="flex items-baseline justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5">
            {t.unread && !active && (
              <span
                aria-label="unread"
                className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-mint"
              />
            )}
            <span className="truncate text-sm font-bold tracking-tight text-deep-green">
              {name}
            </span>
          </span>
          <span className="shrink-0 text-[10px] font-medium text-deep-green/50">
            {timeAgo(t.last_message_at)}
          </span>
        </div>
        <div className="mt-1 truncate text-xs text-deep-green/60">
          {t.last_message_preview ?? "(no messages)"}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <CityChip code={cityCode} />
          <ChannelChip channel={t.channel ?? "sms"} />
          <AssigneeChip assignee={t.assignee} size="sm" />
          {t.match_ambiguous && (
            <span
              title="Phone has historical accounts on file — showing the most recent"
              className="inline-flex items-center gap-0.5 rounded-full bg-muted-soft px-1.5 py-0.5 text-[10px] font-medium text-muted"
            >
              <span aria-hidden>ⓘ</span> historical
            </span>
          )}
        </div>
      </button>
    </li>
  );
}

// ============================================================
// Center pane
// ============================================================
function ConversationPane({
  detail,
  loading,
  error,
  selectedId,
  appUserId,
  operators,
  onAssign,
  onSent,
}: {
  detail: ThreadDetail | null;
  loading: boolean;
  error: string | null;
  selectedId: string | null;
  appUserId: string | null;
  operators: Assignee[];
  onAssign: (threadId: string, userId: string | null) => void;
  onSent: (m: Message) => void;
}) {
  const messages = detail?.messages ?? [];
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, selectedId]);

  if (!selectedId) {
    return (
      <section className="flex flex-1 items-center justify-center bg-white">
        <EmptyState
          icon="💬"
          title="No thread selected"
          subtitle="Pick a conversation from the inbox to view messages."
          centered
        />
      </section>
    );
  }

  return (
    <section className="flex flex-1 flex-col bg-white">
      <div className="border-b border-cream-line px-4 py-3">
        {detail ? (
          <ConversationHeader
            detail={detail}
            operators={operators}
            onAssign={(userId) => onAssign(detail.thread.id, userId)}
          />
        ) : (
          <div className="h-7" />
        )}
      </div>
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto bg-cream-soft px-4 py-3"
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
        <ul className="space-y-2">
          {messages.map((m) => (
            <MessageBubble key={m.id} msg={m} />
          ))}
        </ul>
      </div>
      <Composer
        threadId={selectedId}
        appUserId={appUserId}
        onSent={onSent}
        channel={detail?.thread.channel ?? "sms"}
        whatsappWindowExpired={computeWhatsAppExpired(detail)}
      />
    </section>
  );
}

// WhatsApp's 24-hour session rule: outbound text messages require an
// inbound from the player in the last 24 hours. SMS threads are
// always sendable. Returns true ONLY for WhatsApp threads where the
// latest inbound is older than the window (or there is no inbound
// at all). The server enforces the same rule and 422s if violated;
// this client check just disables the composer pre-emptively.
function computeWhatsAppExpired(detail: ThreadDetail | null): boolean {
  if (!detail) return false;
  if ((detail.thread.channel ?? "sms") !== "whatsapp") return false;
  const iso = detail.latest_inbound_at;
  if (!iso) return true; // no inbound yet → no window to ride
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return true;
  return Date.now() - t > WHATSAPP_WINDOW_MS;
}

function ConversationHeader({
  detail,
  operators,
  onAssign,
}: {
  detail: ThreadDetail;
  operators: Assignee[];
  onAssign: (userId: string | null) => void;
}) {
  const name = displayNameForThread(detail.thread);
  const cityCode = cityCodeForThread(detail.thread);
  const channel = detail.thread.channel ?? "sms";
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <div className="truncate text-base font-extrabold tracking-tight text-deep-green">
          {name}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-deep-green/60">
          <span className="font-mono">{detail.thread.phone_number}</span>
          <CityChip code={cityCode} />
          <span className="inline-flex items-center gap-1 text-[11px] text-deep-green/55">
            <ChannelChip channel={channel} />
            via {channelDisplay(channel)}
          </span>
          {detail.thread.match_ambiguous && (
            <span
              title="Phone has historical accounts on file — showing the most recent"
              className="inline-flex items-center gap-0.5 rounded-full bg-muted-soft px-1.5 py-0.5 text-[10px] font-medium text-muted"
            >
              <span aria-hidden>ⓘ</span> historical
            </span>
          )}
        </div>
      </div>
      <AssignDropdown
        current={detail.assignee}
        operators={operators}
        onAssign={onAssign}
      />
    </div>
  );
}

function AssignDropdown({
  current,
  operators,
  onAssign,
}: {
  current: Assignee | null;
  operators: Assignee[];
  onAssign: (userId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointer(e: MouseEvent | TouchEvent) {
      const target = e.target as Node | null;
      if (ref.current && target && !ref.current.contains(target)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("touchstart", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("touchstart", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex"
      >
        <AssigneeChip
          assignee={current}
          size="md"
          trailing={
            <span aria-hidden className="text-[9px] leading-none opacity-60">
              {open ? "▴" : "▾"}
            </span>
          }
        />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-1 w-56 overflow-hidden rounded-md border border-cream-line bg-white py-1 text-deep-green shadow-lg shadow-deep-green/20"
        >
          {operators.length === 0 && (
            <div className="px-3 py-1.5 text-xs text-deep-green/50">
              No operators loaded.
            </div>
          )}
          {operators.map((op) => {
            const active = current?.id === op.id;
            return (
              <button
                key={op.id}
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onAssign(op.id);
                }}
                className={`flex w-full items-center justify-between px-3 py-1.5 text-sm transition hover:bg-cream-soft ${
                  active ? "bg-mint-soft font-bold" : ""
                }`}
              >
                <span className="truncate">
                  {op.full_name?.trim() || op.email}
                </span>
                {active && (
                  <span aria-hidden className="ml-2 text-xs text-mint-hover">
                    ✓
                  </span>
                )}
              </button>
            );
          })}
          {operators.length > 0 && (
            <div aria-hidden className="my-1 h-px bg-cream-line" />
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onAssign(null);
            }}
            disabled={current == null}
            className="block w-full px-3 py-1.5 text-left text-sm text-deep-green/75 transition hover:bg-cream-soft hover:text-deep-green disabled:opacity-40"
          >
            Unassign
          </button>
        </div>
      )}
    </div>
  );
}

// Outbound delivery state, rendered below the timestamp on each
// outbound bubble. Mirrors the WhatsApp visual idiom: single check
// = accepted by provider, double check = delivered to device, blue-
// tinted double check = read. The old logic checked
// `!telnyx_message_id` to render a red "not delivered" label, which
// fired on every WhatsApp outbound (those store the id under
// external_message_id) — that's the bug this PR closes.
function DeliveryStatusLabel({ status }: { status: DeliveryStatus }) {
  if (status === "failed") {
    return (
      <span className="ml-1 text-coral-hover">· failed to deliver</span>
    );
  }
  if (status === "pending") {
    return <span className="ml-1 text-deep-green/45">· sending…</span>;
  }
  if (status === "delivered") {
    return (
      <span className="ml-1 inline-flex items-center gap-0.5 text-deep-green/55">
        · delivered
        <Check aria-hidden className="h-2.5 w-2.5" strokeWidth={2.5} />
      </span>
    );
  }
  if (status === "read") {
    return (
      <span className="ml-1 inline-flex items-center gap-0.5 text-mint-hover">
        · read
        <CheckCheck aria-hidden className="h-2.5 w-2.5" strokeWidth={2.5} />
      </span>
    );
  }
  // 'sent' — quiet single check, no extra word. Matches the
  // mobile-app idiom for "accepted by server, not yet on the
  // recipient's device."
  return (
    <span className="ml-1 inline-flex items-center text-deep-green/50">
      <Check aria-hidden className="h-2.5 w-2.5" strokeWidth={2.5} />
    </span>
  );
}

function MessageBubble({ msg }: { msg: Message }) {
  const isInbound = msg.direction === "inbound";
  const senderLabel =
    msg.sender?.full_name?.trim() ||
    msg.sender?.email ||
    (msg.sent_by_user_id ? "operator" : null);
  return (
    <li className={`flex flex-col ${isInbound ? "items-start" : "items-end"}`}>
      <div
        className={`max-w-[80%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm leading-relaxed ${
          isInbound
            ? "border border-cream-line bg-white text-deep-green"
            : "bg-mint text-deep-green"
        }`}
      >
        {msg.body}
      </div>
      <div className="mt-0.5 px-1 text-[10px] text-deep-green/50">
        {!isInbound && senderLabel && (
          <span className="mr-1 font-medium">{senderLabel} ·</span>
        )}
        <span>{formatTimestamp(msg.sent_at)}</span>
        {!isInbound && msg.channel === "sms" && msg.segment_count > 1 && (
          <span> · {msg.segment_count} segments</span>
        )}
        {!isInbound && <DeliveryStatusLabel status={msg.delivery_status} />}
      </div>
    </li>
  );
}

function Composer({
  threadId,
  appUserId,
  onSent,
  channel,
  whatsappWindowExpired,
}: {
  threadId: string;
  appUserId: string | null;
  onSent: (m: Message) => void;
  channel: CrmChannel;
  whatsappWindowExpired: boolean;
}) {
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    const next = Math.min(240, Math.max(80, ta.scrollHeight));
    ta.style.height = `${next}px`;
  }, [body]);

  useEffect(() => {
    setBody("");
    setError(null);
  }, [threadId]);

  const budget = useMemo(() => smsBudget(body), [body]);

  const submit = useCallback(async () => {
    if (sending) return;
    if (!body.trim()) return;
    setSending(true);
    setError(null);
    const headers = await bearerHeaders();
    if (!headers) {
      setError("No active session — please sign in again.");
      setSending(false);
      return;
    }
    try {
      const res = await fetch("/api/crm/send", {
        method: "POST",
        headers,
        body: JSON.stringify({ thread_id: threadId, body }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        message?: Message;
        error?: string;
        telnyx_error?: string;
      };
      if (!res.ok) {
        throw new Error(j.telnyx_error || j.error || `HTTP ${res.status}`);
      }
      if (j.message) onSent(j.message);
      setBody("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }, [body, sending, threadId, onSent]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void submit();
      }
    },
    [submit],
  );

  const disabled = sending || !appUserId || whatsappWindowExpired;
  const placeholder = !appUserId
    ? "Sign in to send."
    : whatsappWindowExpired
      ? "WhatsApp session expired — player must message first to reopen the 24-hour window."
      : "Type a reply. Enter to send, Shift+Enter for newline.";

  return (
    <div className="border-t border-cream-line bg-white px-4 py-3">
      {whatsappWindowExpired && (
        <div className="mb-2 rounded-md border border-cream-line bg-cream-soft px-2 py-1.5 text-[11px] text-deep-green/60">
          <span aria-hidden className="mr-1">ⓘ</span>
          WhatsApp session expired — player must message first to reopen the 24-hour window.
        </div>
      )}
      <textarea
        ref={taRef}
        value={body}
        disabled={disabled}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        className="block w-full resize-none rounded-md border border-cream-line bg-white px-3 py-2 text-sm text-deep-green placeholder:text-deep-green/40 focus:border-deep-green focus:outline-none disabled:bg-cream-soft disabled:text-deep-green/40"
        style={{ minHeight: 80, maxHeight: 240 }}
      />
      <div className="mt-2 flex items-center justify-between text-xs text-deep-green/60">
        <div>
          <span className="font-medium text-deep-green">{body.length}</span>{" "}
          chars
          {channel === "sms" && (
            <>
              {" · "}
              {budget.encoding === "gsm7"
                ? "GSM-7 (160/seg)"
                : "UCS-2 (70/seg)"}
              {" · "}
              <span className="font-medium text-deep-green">
                {budget.segments}
              </span>{" "}
              segment{budget.segments === 1 ? "" : "s"}
            </>
          )}
          {error && <span className="ml-2 text-coral-hover">{error}</span>}
        </div>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={sending || !body.trim() || !appUserId || whatsappWindowExpired}
          className="rounded-full bg-deep-green px-3 py-1 text-xs font-medium text-cream transition hover:bg-deep-green-hover disabled:opacity-40"
        >
          {sending ? "Sending…" : "Send"}
        </button>
      </div>
    </div>
  );
}

// ============================================================
// Right pane
// ============================================================
function PlayerPane({
  detail,
  selectedThread,
  loading,
  collapsed,
  onToggleCollapsed,
}: {
  detail: ThreadDetail | null;
  selectedThread: ThreadListRow | null;
  loading: boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  const supabaseProjectRef =
    process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(
      /^https:\/\/([^.]+)\..*/,
      "$1",
    ) ?? null;

  return (
    <aside
      className="flex shrink-0 flex-col overflow-hidden border-l border-cream-line bg-cream-soft transition-[width] duration-200 ease-out"
      style={{ width: collapsed ? 40 : 260 }}
    >
      <div className="flex h-9 items-center justify-between border-b border-cream-line bg-cream-soft px-2">
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-label={collapsed ? "Expand context" : "Collapse context"}
          className="mr-auto inline-flex h-6 w-6 items-center justify-center rounded text-deep-green/60 transition hover:bg-white hover:text-deep-green"
        >
          {collapsed ? "‹" : "›"}
        </button>
        {!collapsed && (
          <span className="px-1 text-[11px] font-semibold uppercase tracking-wide text-deep-green/60">
            Context
          </span>
        )}
      </div>

      {collapsed ? (
        <button
          type="button"
          onClick={onToggleCollapsed}
          className="flex-1 text-[10px] uppercase tracking-widest text-deep-green/40 [writing-mode:vertical-rl]"
          aria-label="Expand context"
        >
          Context
        </button>
      ) : (
        <div className="flex-1 overflow-y-auto p-3">
          {!selectedThread ? (
            <div className="text-xs text-deep-green/40">
              No player selected.
            </div>
          ) : (
            <PlayerCard
              detail={detail}
              selectedThread={selectedThread}
              loading={loading}
              supabaseProjectRef={supabaseProjectRef}
            />
          )}
        </div>
      )}
    </aside>
  );
}

function PlayerCard({
  detail,
  selectedThread,
  loading,
  supabaseProjectRef,
}: {
  detail: ThreadDetail | null;
  selectedThread: ThreadListRow;
  loading: boolean;
  supabaseProjectRef: string | null;
}) {
  const player = detail?.player ?? null;
  const ambiguous = selectedThread.match_ambiguous;
  const historicalCount = detail?.historical_account_count ?? null;

  return (
    <>
      {ambiguous && (
        <div className="mb-3 flex items-start gap-1.5 rounded-md border border-cream-line bg-cream-soft p-2 text-xs text-deep-green/60">
          <span aria-hidden className="mt-px shrink-0">
            ⓘ
          </span>
          <span>
            Phone has{" "}
            {historicalCount != null && historicalCount > 0
              ? `${historicalCount} historical account${historicalCount === 1 ? "" : "s"}`
              : "historical accounts"}{" "}
            on file — showing the most recent.
          </span>
        </div>
      )}

      {loading && !detail && (
        <div className="text-xs text-deep-green/50">Loading…</div>
      )}

      {player ? (
        <section className="rounded-md border border-cream-line bg-white p-3 shadow-sm">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-deep-green/40">
            Player
          </div>
          <div className="mt-0.5 text-sm font-extrabold tracking-tight text-deep-green">
            {[player.first_name, player.last_name]
              .filter(Boolean)
              .join(" ")
              .trim() || "(no name)"}
          </div>
          <dl className="mt-3 divide-y divide-cream-line text-xs">
            <Row label="City">
              <CityChip
                code={player.preferable_city_normalized ?? UNKNOWN_CITY}
              />
            </Row>
            <Row label="Phone">
              <span className="font-mono">{player.phone_number ?? "—"}</span>
            </Row>
            <Row label="Email">
              <span className="break-all">{player.email ?? "—"}</span>
            </Row>
            <Row label="Member">
              {player.is_member === true
                ? "Yes"
                : player.is_member === false
                  ? "No"
                  : "—"}
            </Row>
            <Row label="Matches">
              {player.total_match_count ?? "—"}
            </Row>
          </dl>
          {supabaseProjectRef && (
            <a
              href={`https://supabase.com/dashboard/project/${supabaseProjectRef}/editor?schema=public&table=mdapi_users&filter=id%3Aeq%3A${player.id}`}
              target="_blank"
              rel="noreferrer"
              className="mt-3 inline-block text-xs font-medium text-deep-green underline decoration-deep-green/30 underline-offset-2 hover:decoration-deep-green"
            >
              View in Supabase →
            </a>
          )}
        </section>
      ) : !loading ? (
        <section className="rounded-md border border-dashed border-cream-line bg-white p-3 text-xs text-deep-green/70">
          <div className="font-bold text-deep-green">Unknown number</div>
          <p className="mt-1">
            No mdapi_users row matched this phone. Search-by-name to link
            will land in Phase 2; for now look up the player manually.
          </p>
          <div className="mt-2 font-mono text-deep-green/50">
            {selectedThread.phone_number}
          </div>
        </section>
      ) : null}

      <RecentMatchesSection
        matches={detail?.recent_matches ?? []}
        hasPlayer={player != null}
        loading={loading && !detail}
      />
    </>
  );
}

function RecentMatchesSection({
  matches,
  hasPlayer,
  loading,
}: {
  matches: RecentMatch[];
  hasPlayer: boolean;
  loading: boolean;
}) {
  return (
    <section className="mt-3 rounded-md border border-cream-line bg-white p-3 shadow-sm">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-deep-green/40">
        Recent matches
      </div>
      {loading ? (
        <div className="mt-2 text-xs text-deep-green/50">Loading…</div>
      ) : !hasPlayer ? (
        <div className="mt-2 text-xs text-deep-green/45">
          No player linked.
        </div>
      ) : matches.length === 0 ? (
        <div className="mt-2 text-xs text-deep-green/45">
          No recent matches.
        </div>
      ) : (
        <ul className="mt-2 divide-y divide-cream-line">
          {matches.map((m) => (
            <li
              key={m.match_api_id}
              className="flex flex-col gap-1 py-2 first:pt-0 last:pb-0"
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-xs font-semibold text-deep-green">
                  {m.venue?.trim() || "(no venue)"}
                </span>
                <span className="shrink-0 text-[10px] text-deep-green/50">
                  {formatMatchDate(m.start_date)}
                </span>
              </div>
              <div>
                <MatchStatusPill status={m.status} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function formatMatchDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 py-1.5">
      <dt className="shrink-0 text-deep-green/50">{label}</dt>
      <dd className="min-w-0 text-right text-deep-green">{children}</dd>
    </div>
  );
}

// ============================================================
// Misc
// ============================================================
function EmptyState({
  icon,
  title,
  subtitle,
  centered,
}: {
  icon: string;
  title: string;
  subtitle: string;
  centered?: boolean;
}) {
  return (
    <div
      className={`flex flex-col items-center gap-2 px-6 py-8 text-center ${
        centered ? "" : ""
      }`}
    >
      <div aria-hidden className="text-2xl opacity-70">
        {icon}
      </div>
      <div className="text-sm font-bold text-deep-green">{title}</div>
      <div className="max-w-[28ch] text-xs text-deep-green/55">{subtitle}</div>
    </div>
  );
}

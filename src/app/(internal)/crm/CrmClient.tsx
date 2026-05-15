"use client";

// Phase 0 CRM MVP — three-pane SMS console.
//
//   Left   (260px): thread list, ordered by last_message_at desc.
//                   Unread dot tracked in localStorage (per-thread
//                   last-viewed timestamp; no server-side read state
//                   in Phase 0).
//   Center:         empty state OR conversation view. Auto-expanding
//                   textarea, Enter to send, Shift+Enter newline,
//                   segment counter.
//   Right  (240px): player context — name, city, phone, email,
//                   member status, total matches, "View in Supabase"
//                   link. Surfaces match_ambiguous warning.
//
// Realtime: subscribes to crm_messages INSERTs and crm_threads
// UPDATEs to push live updates. Falls back gracefully if the
// subscription channel fails (manual refresh button still works).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/useAuth";

// ---------------- types ----------------

type ThreadListRow = {
  id: string;
  phone_number: string;
  player_id: number | null;
  match_ambiguous: boolean;
  last_message_at: string;
  last_message_preview: string | null;
  created_at: string;
  player: {
    first_name: string | null;
    last_name: string | null;
    preferable_city_normalized: string | null;
  } | null;
};

type Message = {
  id: string;
  thread_id: string;
  direction: "inbound" | "outbound";
  body: string;
  sent_at: string;
  sent_by_user_id: string | null;
  telnyx_message_id: string | null;
  segment_count: number;
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

type ThreadDetail = {
  thread: ThreadListRow;
  messages: Message[];
  player: PlayerContext | null;
};

// ---------------- helpers ----------------

const LAST_VIEWED_KEY = "crm:lastViewed:v1";

function readLastViewed(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(LAST_VIEWED_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, string>;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function writeLastViewed(map: Record<string, string>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LAST_VIEWED_KEY, JSON.stringify(map));
  } catch {
    // localStorage may be unavailable (e.g. private mode) — silently
    // degrade; unread dots will reset on refresh.
  }
}

function displayNameForThread(t: ThreadListRow): string {
  if (t.player) {
    const first = t.player.first_name?.trim() ?? "";
    const last = t.player.last_name?.trim() ?? "";
    const full = `${first} ${last}`.trim();
    if (full) return full;
  }
  return t.phone_number;
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

// GSM-7 character set (3GPP TS 23.038 default alphabet + extension).
// Anything outside this triggers UCS-2 encoding, which caps a single
// segment at 70 chars instead of 160.
//
// Extension chars (€, [, ], {, }, ~, \, |, ^, form feed) cost two
// GSM-7 code units each. We don't worry about that nuance — we just
// determine the encoding bucket.
const GSM7_RX =
  /^[\n\rA-Za-z0-9 @£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà€\\[\]{}|~^]*$/;

function smsBudget(body: string): {
  encoding: "gsm7" | "ucs2";
  segmentSize: number;
  segments: number;
  remaining: number;
} {
  const encoding = GSM7_RX.test(body) ? "gsm7" : "ucs2";
  // First segment is 160 (GSM-7) or 70 (UCS-2). Multi-segment
  // payloads use slightly smaller chunks because of UDH overhead,
  // but for display we just use the single-segment size.
  const segmentSize = encoding === "gsm7" ? 160 : 70;
  const len = body.length;
  const segments = len === 0 ? 0 : Math.ceil(len / segmentSize);
  const remaining = segmentSize - (len % segmentSize || segmentSize);
  return { encoding, segmentSize, segments, remaining };
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

// ---------------- main component ----------------

export default function CrmClient() {
  const { appUser } = useAuth();

  const [threads, setThreads] = useState<ThreadListRow[]>([]);
  const [threadsError, setThreadsError] = useState<string | null>(null);
  const [threadsLoading, setThreadsLoading] = useState(true);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ThreadDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [lastViewed, setLastViewed] = useState<Record<string, string>>({});
  const [realtimeOk, setRealtimeOk] = useState<boolean | null>(null);

  // Load last-viewed map from localStorage on mount.
  useEffect(() => {
    setLastViewed(readLastViewed());
  }, []);

  // ---------------- threads list fetch ----------------
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

  useEffect(() => {
    void loadThreads();
  }, [loadThreads]);

  // ---------------- detail fetch on select ----------------
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
        writeLastViewed(next);
        return next;
      });
    },
    [loadDetail],
  );

  // ---------------- realtime ----------------
  // Subscribe once per mount. New messages: append to detail if it's
  // the open thread; bump the row in the threads list either way.
  // Thread updates: merge into list.
  const selectedRef = useRef<string | null>(null);
  useEffect(() => {
    selectedRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    const channel = supabase
      .channel("crm-stream")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "crm_messages" },
        (payload) => {
          const m = payload.new as Message;
          // If the open thread, append (dedupe by id).
          if (m.thread_id === selectedRef.current) {
            setDetail((prev) => {
              if (!prev) return prev;
              if (prev.messages.some((x) => x.id === m.id)) return prev;
              return { ...prev, messages: [...prev.messages, m] };
            });
          }
          // Always bump the matching row in the list (preview +
          // last_message_at). Server-side trigger also updates
          // crm_threads, which will arrive via the UPDATE channel —
          // but we update optimistically here too so the left
          // column doesn't lag the center pane.
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
        { event: "UPDATE", schema: "public", table: "crm_threads" },
        (payload) => {
          const t = payload.new as ThreadListRow;
          setThreads((prev) => {
            const exists = prev.find((x) => x.id === t.id);
            if (!exists) {
              // New thread (inserted by webhook) — refetch list to
              // get the join'd player payload.
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
                  }
                : x,
            );
          });
        },
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "crm_threads" },
        () => {
          // New conversation from an unknown number. Cheapest path
          // is to refetch the list with the joined player payload.
          void loadThreads();
        },
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          setRealtimeOk(true);
        } else if (
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
  }, [loadThreads]);

  // Sort threads by last_message_at desc, with unread-flag derivation.
  const sortedThreads = useMemo(() => {
    const arr = [...threads].sort(
      (a, b) => Date.parse(b.last_message_at) - Date.parse(a.last_message_at),
    );
    return arr.map((t) => {
      const seenAt = lastViewed[t.id];
      const unread =
        !!t.last_message_preview &&
        (seenAt == null ||
          Date.parse(t.last_message_at) > Date.parse(seenAt));
      return { ...t, unread };
    });
  }, [threads, lastViewed]);

  const selectedThread = sortedThreads.find((t) => t.id === selectedId) ?? null;

  return (
    <div className="-mx-6 -my-8 flex h-[calc(100vh-4rem)] flex-col">
      <div className="border-b border-cream-line bg-white px-6 py-3">
        <div className="flex items-baseline justify-between">
          <h1 className="text-xl font-bold tracking-tight text-deep-green">
            CRM
          </h1>
          <div className="flex items-center gap-3 text-xs text-deep-green/60">
            <span>
              {threadsLoading
                ? "Loading…"
                : `${threads.length} conversation${threads.length === 1 ? "" : "s"}`}
            </span>
            <span aria-label="realtime status">
              {realtimeOk == null
                ? "· connecting…"
                : realtimeOk
                  ? "· live"
                  : "· offline (refresh manually)"}
            </span>
            <button
              type="button"
              onClick={() => void loadThreads()}
              className="rounded border border-cream-line px-2 py-0.5 hover:bg-cream-soft"
            >
              Refresh
            </button>
          </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <ThreadList
          threads={sortedThreads}
          selectedId={selectedId}
          onSelect={selectThread}
          loading={threadsLoading}
          error={threadsError}
        />
        <Conversation
          detail={detail}
          loading={detailLoading}
          error={detailError}
          selectedId={selectedId}
          appUserId={appUser?.id ?? null}
          onSent={(msg) => {
            // Optimistic: append + update threads-list preview. The
            // realtime subscription will arrive shortly after and
            // dedupe by id.
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
        />
      </div>
    </div>
  );
}

// ---------------- left pane ----------------

function ThreadList({
  threads,
  selectedId,
  onSelect,
  loading,
  error,
}: {
  threads: (ThreadListRow & { unread: boolean })[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  loading: boolean;
  error: string | null;
}) {
  return (
    <aside className="w-[260px] shrink-0 overflow-y-auto border-r border-cream-line bg-cream-soft">
      {error && (
        <div className="border-b border-rust/30 bg-rust/10 p-3 text-xs text-rust">
          {error}
        </div>
      )}
      {loading && threads.length === 0 && (
        <div className="p-3 text-xs text-deep-green/50">Loading…</div>
      )}
      {!loading && threads.length === 0 && !error && (
        <div className="p-3 text-xs text-deep-green/50">
          No conversations yet. Send a text from a phone to the Telnyx number
          to start one.
        </div>
      )}
      <ul className="divide-y divide-cream-line">
        {threads.map((t) => {
          const name = displayNameForThread(t);
          const city = t.player?.preferable_city_normalized ?? null;
          const active = t.id === selectedId;
          return (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => onSelect(t.id)}
                className={`block w-full px-3 py-2 text-left transition ${
                  active ? "bg-mint-soft" : "hover:bg-white"
                }`}
              >
                <div className="flex items-center gap-2">
                  {t.unread && !active && (
                    <span
                      aria-label="unread"
                      className="inline-block h-2 w-2 shrink-0 rounded-full bg-mint"
                    />
                  )}
                  <span className="flex-1 truncate text-sm font-semibold text-deep-green">
                    {name}
                  </span>
                  <span className="shrink-0 text-[10px] text-deep-green/50">
                    {timeAgo(t.last_message_at)}
                  </span>
                </div>
                <div className="mt-0.5 flex items-center gap-2">
                  {city && (
                    <span className="rounded-full bg-deep-green/10 px-1.5 py-0.5 text-[10px] font-medium text-deep-green/70">
                      {city}
                    </span>
                  )}
                  {t.match_ambiguous && (
                    <span
                      title="Multiple users share this phone number"
                      className="rounded-full bg-rust/15 px-1.5 py-0.5 text-[10px] font-medium text-rust"
                    >
                      ambiguous
                    </span>
                  )}
                  <span className="flex-1 truncate text-xs text-deep-green/60">
                    {t.last_message_preview ?? "(no messages)"}
                  </span>
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}

// ---------------- center pane ----------------

function Conversation({
  detail,
  loading,
  error,
  selectedId,
  appUserId,
  onSent,
}: {
  detail: ThreadDetail | null;
  loading: boolean;
  error: string | null;
  selectedId: string | null;
  appUserId: string | null;
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
        <div className="text-sm text-deep-green/50">
          Select a conversation to view messages.
        </div>
      </section>
    );
  }

  return (
    <section className="flex flex-1 flex-col bg-white">
      <div className="border-b border-cream-line px-4 py-3">
        {detail?.thread ? (
          <ConversationHeader detail={detail} />
        ) : (
          <div className="h-5" />
        )}
      </div>
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto bg-cream-soft px-4 py-3"
      >
        {error && (
          <div className="mb-3 rounded border border-rust/30 bg-rust/10 p-2 text-xs text-rust">
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
      />
    </section>
  );
}

function ConversationHeader({ detail }: { detail: ThreadDetail }) {
  const name = displayNameForThread(detail.thread);
  const city = detail.player?.preferable_city_normalized ?? null;
  return (
    <div className="flex items-baseline justify-between">
      <div>
        <div className="text-base font-bold text-deep-green">{name}</div>
        <div className="mt-0.5 text-xs text-deep-green/60">
          {detail.thread.phone_number}
          {city && <span className="ml-2">· {city}</span>}
        </div>
      </div>
      {detail.thread.match_ambiguous && (
        <span className="rounded-full bg-rust/15 px-2 py-0.5 text-xs font-medium text-rust">
          Multiple matches — verify player
        </span>
      )}
    </div>
  );
}

function MessageBubble({ msg }: { msg: Message }) {
  const isInbound = msg.direction === "inbound";
  const senderLabel =
    msg.sender?.full_name?.trim() ||
    msg.sender?.email ||
    (msg.sent_by_user_id ? "operator" : null);
  return (
    <li
      className={`flex flex-col ${isInbound ? "items-start" : "items-end"}`}
    >
      <div
        className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap ${
          isInbound
            ? "bg-white text-deep-green border border-cream-line"
            : "bg-mint text-deep-green"
        }`}
      >
        {msg.body}
      </div>
      <div className="mt-0.5 px-1 text-[10px] text-deep-green/50">
        {!isInbound && senderLabel && (
          <span className="mr-1">{senderLabel} ·</span>
        )}
        {formatTimestamp(msg.sent_at)}
        {!isInbound && msg.segment_count > 1 && (
          <span> · {msg.segment_count} segments</span>
        )}
        {!isInbound && !msg.telnyx_message_id && (
          <span className="ml-1 text-rust">· not delivered</span>
        )}
      </div>
    </li>
  );
}

function Composer({
  threadId,
  appUserId,
  onSent,
}: {
  threadId: string;
  appUserId: string | null;
  onSent: (m: Message) => void;
}) {
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Auto-expand textarea between 80 and 240 px.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    const next = Math.min(240, Math.max(80, ta.scrollHeight));
    ta.style.height = `${next}px`;
  }, [body]);

  // Reset on thread switch.
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
        throw new Error(
          j.telnyx_error || j.error || `HTTP ${res.status}`,
        );
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

  return (
    <div className="border-t border-cream-line bg-white px-4 py-3">
      <textarea
        ref={taRef}
        value={body}
        disabled={sending || !appUserId}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={
          appUserId
            ? "Type a reply. Enter to send, Shift+Enter for newline."
            : "Sign in to send."
        }
        className="block w-full resize-none rounded border border-cream-line bg-white px-3 py-2 text-sm text-deep-green placeholder:text-deep-green/40 focus:border-deep-green focus:outline-none"
        style={{ minHeight: 80, maxHeight: 240 }}
      />
      <div className="mt-2 flex items-center justify-between text-xs text-deep-green/60">
        <div>
          {body.length} chars · {budget.encoding === "gsm7"
            ? `GSM-7 (160/segment)`
            : `UCS-2 (70/segment)`}{" "}
          · {budget.segments} segment{budget.segments === 1 ? "" : "s"}
          {error && <span className="ml-2 text-rust">{error}</span>}
        </div>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={sending || !body.trim() || !appUserId}
          className="rounded bg-deep-green px-3 py-1 text-xs font-medium text-cream disabled:opacity-40"
        >
          {sending ? "Sending…" : "Send"}
        </button>
      </div>
    </div>
  );
}

// ---------------- right pane ----------------

function PlayerPane({
  detail,
  selectedThread,
  loading,
}: {
  detail: ThreadDetail | null;
  selectedThread: ThreadListRow | null;
  loading: boolean;
}) {
  if (!selectedThread) {
    return (
      <aside className="w-[240px] shrink-0 overflow-y-auto border-l border-cream-line bg-cream-soft p-3 text-xs text-deep-green/40">
        No player selected.
      </aside>
    );
  }

  const supabaseProjectRef =
    process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(
      /^https:\/\/([^.]+)\..*/,
      "$1",
    ) ?? null;

  const player = detail?.player ?? null;
  const ambiguous = selectedThread.match_ambiguous;

  return (
    <aside className="w-[240px] shrink-0 overflow-y-auto border-l border-cream-line bg-cream-soft p-3">
      {loading && !detail && (
        <div className="text-xs text-deep-green/50">Loading…</div>
      )}
      {ambiguous && (
        <div className="mb-3 rounded border border-rust/30 bg-rust/10 p-2 text-xs text-rust">
          <strong>Ambiguous match:</strong> more than one mdapi_users row
          shares this phone. The oldest signup was auto-selected — verify
          before replying.
        </div>
      )}
      {player ? (
        <>
          <div className="text-xs uppercase tracking-wide text-deep-green/50">
            Player
          </div>
          <div className="mt-1 text-sm font-bold text-deep-green">
            {[player.first_name, player.last_name]
              .filter(Boolean)
              .join(" ")
              .trim() || "(no name)"}
          </div>
          <dl className="mt-3 space-y-2 text-xs">
            <Row label="City">
              {player.preferable_city_normalized ?? "—"}
              {player.preferable_city_name &&
                player.preferable_city_name !==
                  player.preferable_city_normalized && (
                  <span className="text-deep-green/50">
                    {" "}
                    · {player.preferable_city_name}
                  </span>
                )}
            </Row>
            <Row label="Phone">
              {player.phone_number ?? "—"}
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
              className="mt-4 inline-block text-xs text-deep-green underline hover:text-mint"
            >
              View in Supabase →
            </a>
          )}
        </>
      ) : !loading ? (
        <div className="rounded border border-cream-line bg-white p-3 text-xs text-deep-green/70">
          <div className="font-semibold text-deep-green">Unknown number</div>
          <p className="mt-1">
            No mdapi_users row matched this phone. Search-by-name to link
            will be added next; for now, look up the player manually.
          </p>
          <div className="mt-2 text-deep-green/50">
            {selectedThread.phone_number}
          </div>
        </div>
      ) : null}
    </aside>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-deep-green/50">{label}</dt>
      <dd className="text-right text-deep-green">{children}</dd>
    </div>
  );
}

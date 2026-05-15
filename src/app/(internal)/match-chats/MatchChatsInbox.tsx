"use client";

// Left pane of the two-pane Match Chats shell. Tabs (Active /
// Upcoming) replace the previous stacked-section layout. Collapsible
// to a 40px strip; collapse state persists in localStorage.
//
// Selection is owned by the parent (MatchChatsClient): this component
// receives `selectedChatId` for the active-row highlight and calls
// `onSelect(chatId)` when a row is clicked. URL state (chatId + tab)
// is managed by the parent via useSearchParams.
//
// Realtime: a coarse collection-group listener triggers a full inbox
// refetch whenever a new message lands in the active window. We keep
// the existing match-title text up to date via formatMatchTitle so
// city-local times stay correct as DST flips, etc.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  collectionGroup,
  onSnapshot,
  orderBy,
  query,
  Timestamp,
  where,
} from "firebase/firestore";
import { supabase } from "@/lib/supabase";
import { useFirebaseSession } from "@/lib/useFirebaseSession";
import {
  ACTIVE_WINDOW_DAYS,
  type MatchChatInboxResponse,
  type MatchChatInboxRow,
} from "@/lib/matchChats";
import { formatMatchTitle } from "@/lib/cityTimezones";
import CityChip from "@/components/CityChip";

export type InboxTab = "active" | "upcoming";

const COLLAPSE_KEY = "cockpit:match-chats:inbox-collapsed";

// ---------------- helpers ----------------

async function fetchInbox(): Promise<MatchChatInboxResponse> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("No active session — please sign in again.");
  const res = await fetch("/api/match-chats/active", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as MatchChatInboxResponse;
}

function timeAgo(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const diff = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (diff < 45) return "just now";
  if (diff < 90) return "1m";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 5400) return "1h";
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 172800) return "1d";
  if (diff < 604800) return `${Math.floor(diff / 86400)}d`;
  return new Date(then).toLocaleDateString();
}

function readCollapse(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeCollapse(b: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(COLLAPSE_KEY, b ? "1" : "0");
  } catch {
    // private mode — no-op
  }
}

// ============================================================
// main
// ============================================================

export default function MatchChatsInbox({
  selectedChatId,
  tab,
  onSelect,
  onTabChange,
}: {
  selectedChatId: string | null;
  tab: InboxTab;
  onSelect: (chatId: string) => void;
  onTabChange: (tab: InboxTab) => void;
}) {
  const session = useFirebaseSession();

  const [data, setData] = useState<MatchChatInboxResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    setCollapsed(readCollapse());
  }, []);
  const toggleCollapse = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      writeCollapse(next);
      return next;
    });
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await fetchInbox());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Realtime: coarse refetch on any new message in the active window.
  useEffect(() => {
    if (session.status !== "ready") return;
    const cutoff = new Date(
      Date.now() - ACTIVE_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );
    const q = query(
      collectionGroup(session.db, "messages"),
      where("createdAt", ">=", Timestamp.fromDate(cutoff)),
      orderBy("createdAt", "desc"),
    );
    let firstSnapshot = true;
    const unsub = onSnapshot(
      q,
      (snap) => {
        if (firstSnapshot) {
          firstSnapshot = false;
          return;
        }
        const hasAdditions = snap
          .docChanges()
          .some((c) => c.type === "added");
        if (hasAdditions) void load();
      },
      (err) => {
        console.warn(
          "[match-chats:inbox] realtime listener failed",
          err.message,
        );
      },
    );
    return () => unsub();
  }, [session, load]);

  const activeCount = data?.active.length ?? 0;
  const upcomingCount = data?.upcoming.length ?? 0;
  const rows = (tab === "active" ? data?.active : data?.upcoming) ?? [];

  // ---------------- collapsed strip ----------------
  if (collapsed) {
    return (
      <aside
        className="flex w-10 shrink-0 flex-col overflow-hidden border-r border-cream-line bg-cream-soft transition-[width] duration-200 ease-out"
        style={{ width: 40 }}
      >
        <div className="flex h-9 items-center justify-center border-b border-cream-line bg-cream-soft">
          <button
            type="button"
            onClick={toggleCollapse}
            aria-label="Expand inbox"
            className="inline-flex h-6 w-6 items-center justify-center rounded text-deep-green/60 transition hover:bg-white hover:text-deep-green"
          >
            ›
          </button>
        </div>
        <button
          type="button"
          onClick={toggleCollapse}
          aria-label="Expand inbox"
          className="flex-1 text-[10px] uppercase tracking-widest text-deep-green/40 [writing-mode:vertical-rl]"
        >
          Inbox
        </button>
      </aside>
    );
  }

  // ---------------- expanded panel ----------------
  return (
    <aside
      className="flex w-[320px] shrink-0 flex-col overflow-hidden border-r border-cream-line bg-cream-soft transition-[width] duration-200 ease-out"
      style={{ width: 320 }}
    >
      {/* Header: status + collapse button */}
      <div className="flex h-9 items-center justify-between border-b border-cream-line bg-cream-soft px-2">
        <FirebaseStatus session={session} />
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => void load()}
            className="rounded border border-cream-line bg-white px-2 py-0.5 text-[10px] font-medium text-deep-green transition hover:bg-cream-soft"
          >
            Refresh
          </button>
          <button
            type="button"
            onClick={toggleCollapse}
            aria-label="Collapse inbox"
            className="inline-flex h-6 w-6 items-center justify-center rounded text-deep-green/60 transition hover:bg-white hover:text-deep-green"
          >
            ‹
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex shrink-0 gap-1 border-b border-cream-line bg-cream-soft px-2 py-1.5">
        <TabButton
          active={tab === "active"}
          onClick={() => onTabChange("active")}
          label="Active"
          count={activeCount}
        />
        <TabButton
          active={tab === "upcoming"}
          onClick={() => onTabChange("upcoming")}
          label="Upcoming"
          count={upcomingCount}
        />
      </div>

      {error && (
        <div className="m-2 rounded border border-coral/40 bg-coral-soft p-2 text-xs text-coral-hover">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {loading && !data && (
          <div className="p-3 text-xs text-deep-green/50">Loading…</div>
        )}
        {!loading && rows.length === 0 && !error && (
          <div className="p-4 text-xs text-deep-green/45">
            {tab === "active"
              ? "No messages in the last 7 days."
              : "No upcoming matches in the next 3 days."}
          </div>
        )}
        <ul className="divide-y divide-cream-line">
          {rows.map((r) => (
            <InboxRow
              key={r.chat_id}
              row={r}
              active={r.chat_id === selectedChatId}
              onSelect={() => onSelect(r.chat_id)}
            />
          ))}
        </ul>
      </div>
    </aside>
  );
}

// ---------------- pieces ----------------

function FirebaseStatus({
  session,
}: {
  session: ReturnType<typeof useFirebaseSession>;
}) {
  const label =
    session.status === "ready"
      ? "live"
      : session.status === "error"
        ? "offline"
        : "connecting…";
  const dot =
    session.status === "ready"
      ? "bg-mint"
      : session.status === "error"
        ? "bg-coral"
        : "bg-muted";
  return (
    <span className="inline-flex items-center gap-1.5 px-1 text-[11px] text-deep-green/60">
      <span className={`inline-block h-2 w-2 rounded-full ${dot}`} aria-hidden />
      {label}
    </span>
  );
}

function TabButton({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 rounded-full px-2.5 py-0.5 text-xs font-medium transition ${
        active
          ? "bg-deep-green text-cream"
          : "border border-cream-line bg-white text-deep-green/70 hover:bg-cream-soft"
      }`}
    >
      {label}
      <span className={`ml-1 ${active ? "text-cream/70" : "text-deep-green/40"}`}>
        · {count}
      </span>
    </button>
  );
}

function InboxRow({
  row,
  active,
  onSelect,
}: {
  row: MatchChatInboxRow;
  active: boolean;
  onSelect: () => void;
}) {
  const m = row.match;
  const isCancelled = m?.is_cancelled === true;
  const isOrphan = m == null;
  const isUpcomingEmpty = row.section === "upcoming";
  const dim = (isCancelled || isUpcomingEmpty || isOrphan) && !active;

  const title = useMemo(() => {
    if (isOrphan) return null;
    return formatMatchTitle({
      cityCode: m?.city_identifier ?? null,
      startDateIso: m?.start_date ?? null,
      fieldTitle: m?.field_title ?? null,
    });
  }, [m, isOrphan]);

  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={`block w-full px-3 py-2.5 text-left transition ${
          active
            ? "bg-mint-soft"
            : "border-l-2 border-l-transparent hover:bg-white"
        } ${active ? "border-l-2 border-l-mint" : ""} ${dim ? "opacity-60" : ""}`}
      >
        <div className="flex items-baseline justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            {isOrphan ? (
              <span className="italic text-deep-green/55">
                Match {row.chat_id} · (no match data)
              </span>
            ) : (
              <>
                {title?.cityCode && <CityChip code={title.cityCode} />}
                <span className="text-[10px] text-deep-green/30" aria-hidden>
                  ·
                </span>
                <span className="font-semibold text-deep-green">
                  {title?.date}
                </span>
                {title?.time && (
                  <>
                    <span className="text-[10px] text-deep-green/30" aria-hidden>
                      ·
                    </span>
                    <span className="text-deep-green/70">{title.time}</span>
                    {title.isUtcFallback && (
                      <span className="text-[10px] text-deep-green/40">
                        (UTC)
                      </span>
                    )}
                  </>
                )}
                {isCancelled && (
                  <span className="rounded-full bg-muted-soft px-1.5 py-0.5 text-[9px] font-medium text-muted">
                    Cancelled
                  </span>
                )}
              </>
            )}
          </div>
          {row.last_message && (
            <span className="shrink-0 text-[10px] font-medium text-deep-green/50">
              {timeAgo(row.last_message.sent_at)}
            </span>
          )}
        </div>
        {!isOrphan && title?.venue && (
          <div className="mt-0.5 truncate text-xs font-semibold text-deep-green">
            {title.venue}
          </div>
        )}
        <div className="mt-0.5 truncate text-xs">
          {row.last_message ? (
            <>
              {row.last_message.sent_by && (
                <span className="mr-1 font-medium text-deep-green/70">
                  {row.last_message.sent_by}:
                </span>
              )}
              <span className="text-deep-green/60">
                {row.last_message.body ?? "(media)"}
              </span>
            </>
          ) : (
            <span className="italic text-deep-green/40">No messages yet</span>
          )}
        </div>
      </button>
    </li>
  );
}

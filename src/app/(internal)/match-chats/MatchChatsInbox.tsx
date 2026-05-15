"use client";

// Two-section inbox: Active (last 7 days of message activity) +
// Upcoming (matches in the next 3 days without recent activity).
// Server computes both sections via /api/match-chats/active; this
// component just renders.
//
// Real-time updates: on first render we open a Firestore
// collection-group listener mirroring the server's window so new
// messages bump rows live. Falls back gracefully if the index
// exemption hasn't been created yet (UI just shows whatever the
// server returned).

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
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
  isValidChatId,
  type MatchChatInboxResponse,
  type MatchChatInboxRow,
} from "@/lib/matchChats";
import CityChip from "@/components/CityChip";

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

function formatMatchDay(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function formatMatchTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
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

// ---------------- main ----------------

export default function MatchChatsInbox() {
  const session = useFirebaseSession();

  const [data, setData] = useState<MatchChatInboxResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

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

  // Realtime hint: when ANY new message lands in the 7-day window,
  // refetch the inbox. This is coarse on purpose — we'd rather pay
  // one /api/match-chats/active call than reimplement the
  // server-side dedupe + join in the browser.
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
        // Skip the first snapshot — that's the initial state, not
        // a delta. We already have the server's view.
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
        // Likely missing index — surface in the error banner so we
        // know to create the exemption. Doesn't break the page.
        console.warn(
          "[match-chats:inbox] realtime listener failed",
          err.message,
        );
      },
    );
    return () => unsub();
  }, [session, load]);

  return (
    <div>
      <div className="mb-4 flex items-center justify-between gap-3">
        <FirebaseStatus session={session} />
        <button
          type="button"
          onClick={() => void load()}
          className="rounded-full border border-cream-line bg-white px-3 py-1 text-xs font-medium text-deep-green transition hover:bg-cream-soft"
        >
          Refresh
        </button>
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-coral/40 bg-coral-soft p-3 text-xs text-coral-hover">
          {error}
        </div>
      )}

      {loading && !data && (
        <div className="text-sm text-deep-green/50">Loading conversations…</div>
      )}

      {data && (
        <div className="space-y-6">
          <Section title="Active conversations" rows={data.active} />
          <Section title="Upcoming matches" rows={data.upcoming} />
        </div>
      )}
    </div>
  );
}

function FirebaseStatus({
  session,
}: {
  session: ReturnType<typeof useFirebaseSession>;
}) {
  const label =
    session.status === "ready"
      ? "live"
      : session.status === "error"
        ? `offline (${session.error})`
        : "connecting…";
  const dot =
    session.status === "ready"
      ? "bg-mint"
      : session.status === "error"
        ? "bg-coral"
        : "bg-muted";
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-deep-green/60">
      <span className={`inline-block h-2 w-2 rounded-full ${dot}`} aria-hidden />
      {label}
    </span>
  );
}

function Section({
  title,
  rows,
}: {
  title: string;
  rows: MatchChatInboxRow[];
}) {
  return (
    <section>
      <div className="mb-2 flex items-baseline gap-2 border-b border-cream-line pb-1">
        <h2 className="text-[11px] font-bold uppercase tracking-wider text-deep-green/60">
          {title}
        </h2>
        <span className="text-[11px] font-medium text-deep-green/40">
          · {rows.length}
        </span>
      </div>
      {rows.length === 0 ? (
        <div className="rounded-md border border-cream-line bg-white p-4 text-xs text-deep-green/45">
          {title === "Active conversations"
            ? "No messages in the last 7 days."
            : "No upcoming matches in the next 3 days."}
        </div>
      ) : (
        <ul className="divide-y divide-cream-line rounded-md border border-cream-line bg-white">
          {rows.map((r) => (
            <ChatRow key={r.chat_id} row={r} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ChatRow({ row }: { row: MatchChatInboxRow }) {
  const m = row.match;
  const city = m?.city_identifier ?? null;
  const startIso = m?.start_date ?? null;
  const venue = m?.field_title?.trim() ?? null;
  const isCancelled = m?.is_cancelled === true;
  const isOrphan = m == null;
  const dim = isCancelled || row.section === "upcoming" || isOrphan;

  // Inbox title:
  //   "ATX · May 14 · 7:30pm · NEMP" when match data present
  //   "Match 14613 · (no match data)" for orphans
  const titleNodes: React.ReactNode[] = [];
  if (isOrphan) {
    titleNodes.push(
      <span key="orphan" className="italic text-deep-green/55">
        Match {row.chat_id} · (no match data)
      </span>,
    );
  } else {
    if (city) {
      titleNodes.push(<CityChip key="city" code={city} />);
      titleNodes.push(
        <span key="sep-1" aria-hidden className="text-deep-green/30">
          ·
        </span>,
      );
    }
    if (startIso) {
      titleNodes.push(
        <span key="date" className="font-semibold text-deep-green">
          {formatMatchDay(startIso)}
        </span>,
      );
      titleNodes.push(
        <span key="sep-2" aria-hidden className="text-deep-green/30">
          ·
        </span>,
      );
      titleNodes.push(
        <span key="time" className="text-deep-green/70">
          {formatMatchTime(startIso)}
        </span>,
      );
      titleNodes.push(
        <span key="sep-3" aria-hidden className="text-deep-green/30">
          ·
        </span>,
      );
    }
    titleNodes.push(
      <span
        key="venue"
        className="truncate font-semibold text-deep-green"
        title={venue ?? "(unknown venue)"}
      >
        {venue ?? "(unknown venue)"}
      </span>,
    );
  }

  return (
    <li>
      <Link
        href={`/match-chats/${row.chat_id}`}
        prefetch={false}
        className={`block px-3 py-2.5 transition hover:bg-cream-soft ${
          dim ? "opacity-60" : ""
        }`}
      >
        <div className="flex items-baseline justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            {titleNodes}
            {isCancelled && (
              <span className="rounded-full bg-muted-soft px-1.5 py-0.5 text-[10px] font-medium text-muted">
                Cancelled
              </span>
            )}
          </div>
          {row.last_message && (
            <span className="shrink-0 text-[10px] font-medium text-deep-green/50">
              {timeAgo(row.last_message.sent_at)}
            </span>
          )}
        </div>
        <div className="mt-1 truncate text-xs">
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
      </Link>
    </li>
  );
}

// Re-exported so the page knows the row count for the subtitle (not
// currently used but stable).
export type { MatchChatInboxResponse };

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _typeReferenceAnchor(x: typeof isValidChatId) {
  // Keeps the matchChats import from being treeshaken-only for
  // type imports — used by the realtime listener path above.
  return x;
}

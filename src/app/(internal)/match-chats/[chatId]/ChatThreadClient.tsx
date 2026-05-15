"use client";

// Detail view for a single match chat.
//   - Opens a Firestore listener on Chats/{chatId}/messages ordered
//     by createdAt desc, limit 50. New messages stream in live.
//   - "Load older" button at the top of the scroll region uses
//     startAfter() to page back through history 50 at a time.
//   - Composer at the bottom POSTs to /api/match-chats/[chatId]/reply.
//     The route writes to Firestore as "MatchDay" and audit-logs the
//     actual operator.
//   - Sender role badges derived from the joined mdapi_matches data
//     (manager_email match → "Manager", @playmatchday.com → "Staff",
//     sentBy === "MatchDay" → "MatchDay").

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import {
  collection,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  startAfter,
  getDocs,
  type DocumentSnapshot,
  type QuerySnapshot,
} from "firebase/firestore";
import { supabase } from "@/lib/supabase";
import { useFirebaseSession } from "@/lib/useFirebaseSession";
import CityChip from "@/components/CityChip";
import SenderBadge, { type SenderRole } from "@/components/SenderBadge";
import MatchChatMessageMedia from "@/components/MatchChatMessageMedia";
import {
  classifyMessage,
  createdAtToIso,
  isValidChatId,
  MATCHDAY_SENDER_NAME,
  MESSAGE_PAGE_SIZE,
  type FirestoreMessage,
} from "@/lib/matchChats";

// ---------------- types ----------------

type MatchContext = {
  api_id: number;
  field_title: string | null;
  field_address: string | null;
  start_date: string | null;
  city_identifier: string | null;
  city_name: string | null;
  manager_email: string | null;
  manager_first_name: string | null;
  manager_last_name: string | null;
  is_cancelled: boolean | null;
};

type WireMessage = FirestoreMessage & { __docId: string };

// ---------------- helpers ----------------

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

function deriveSenderRole(
  msg: FirestoreMessage,
  match: MatchContext | null,
): SenderRole | null {
  if (msg.sentBy === MATCHDAY_SENDER_NAME) return "matchday";
  const email = msg.user?.email?.toLowerCase()?.trim();
  if (!email) return null;
  if (email.endsWith("@playmatchday.com")) return "staff";
  const managerEmail = match?.manager_email?.toLowerCase()?.trim();
  if (managerEmail && email === managerEmail) return "manager";
  return null;
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

export default function ChatThreadClient({ chatId }: { chatId: string }) {
  const session = useFirebaseSession();

  const [match, setMatch] = useState<MatchContext | null>(null);
  const [matchError, setMatchError] = useState<string | null>(null);

  const [messages, setMessages] = useState<WireMessage[]>([]);
  const [oldestCursor, setOldestCursor] = useState<DocumentSnapshot | null>(
    null,
  );
  const [hasMore, setHasMore] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [listenError, setListenError] = useState<string | null>(null);

  const validId = isValidChatId(chatId);

  // Fetch match context on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const headers = await bearerHeaders();
      if (!headers) {
        if (!cancelled) setMatchError("No active session — sign in again.");
        return;
      }
      try {
        const res = await fetch(`/api/match-chats/${chatId}`, { headers });
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? `HTTP ${res.status}`);
        }
        const j = (await res.json()) as {
          chat_id: string;
          match: MatchContext | null;
        };
        if (!cancelled) setMatch(j.match);
      } catch (err) {
        if (!cancelled)
          setMatchError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chatId]);

  // Realtime listener on the message subcollection, newest 50.
  useEffect(() => {
    if (!validId) return;
    if (session.status !== "ready") return;

    const messagesRef = collection(
      doc(session.db, "Chats", chatId),
      "messages",
    );
    const q = query(
      messagesRef,
      orderBy("createdAt", "desc"),
      limit(MESSAGE_PAGE_SIZE),
    );
    const unsub = onSnapshot(
      q,
      (snap: QuerySnapshot) => {
        // Replace the first-page slice each snapshot. Older pages
        // (loaded via startAfter) stay in state untouched.
        setMessages((prev) => {
          const olderDocIds = new Set(
            prev
              .slice(MESSAGE_PAGE_SIZE)
              .map((m) => m.__docId),
          );
          const fresh: WireMessage[] = snap.docs.map((d) => ({
            ...(d.data() as FirestoreMessage),
            __docId: d.id,
          }));
          const older = prev.filter((m) => olderDocIds.has(m.__docId));
          // Sort everything ascending for display.
          const combined = [...fresh, ...older].sort((a, b) => {
            const at = Date.parse(createdAtToIso(a.createdAt) ?? "") || 0;
            const bt = Date.parse(createdAtToIso(b.createdAt) ?? "") || 0;
            return at - bt;
          });
          // Dedupe by Firestore doc id just in case.
          const seen = new Set<string>();
          const out: WireMessage[] = [];
          for (const m of combined) {
            if (seen.has(m.__docId)) continue;
            seen.add(m.__docId);
            out.push(m);
          }
          return out;
        });
        if (snap.docs.length > 0) {
          // The "oldest" cursor for pagination is the LAST doc in
          // descending order = the oldest message in this snapshot.
          setOldestCursor(snap.docs[snap.docs.length - 1]);
        }
        if (snap.docs.length < MESSAGE_PAGE_SIZE) setHasMore(false);
      },
      (err) => {
        console.error("[match-chats:thread] listener failed", err);
        setListenError(err.message);
      },
    );
    return () => unsub();
  }, [chatId, validId, session]);

  const loadOlder = useCallback(async () => {
    if (loadingOlder || !hasMore || !oldestCursor) return;
    if (session.status !== "ready") return;
    setLoadingOlder(true);
    try {
      const messagesRef = collection(
        doc(session.db, "Chats", chatId),
        "messages",
      );
      const q = query(
        messagesRef,
        orderBy("createdAt", "desc"),
        startAfter(oldestCursor),
        limit(MESSAGE_PAGE_SIZE),
      );
      const snap = await getDocs(q);
      if (snap.empty) {
        setHasMore(false);
      } else {
        const fresh: WireMessage[] = snap.docs.map((d) => ({
          ...(d.data() as FirestoreMessage),
          __docId: d.id,
        }));
        setMessages((prev) => {
          const all = [...fresh, ...prev].sort((a, b) => {
            const at = Date.parse(createdAtToIso(a.createdAt) ?? "") || 0;
            const bt = Date.parse(createdAtToIso(b.createdAt) ?? "") || 0;
            return at - bt;
          });
          const seen = new Set<string>();
          const out: WireMessage[] = [];
          for (const m of all) {
            if (seen.has(m.__docId)) continue;
            seen.add(m.__docId);
            out.push(m);
          }
          return out;
        });
        setOldestCursor(snap.docs[snap.docs.length - 1]);
        if (snap.docs.length < MESSAGE_PAGE_SIZE) setHasMore(false);
      }
    } catch (err) {
      console.error("[match-chats:thread] loadOlder failed", err);
    } finally {
      setLoadingOlder(false);
    }
  }, [chatId, hasMore, loadingOlder, oldestCursor, session]);

  // Compose
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    const next = Math.min(240, Math.max(80, ta.scrollHeight));
    ta.style.height = `${next}px`;
  }, [body]);

  const submit = useCallback(async () => {
    if (sending) return;
    if (!body.trim()) return;
    setSending(true);
    setSendError(null);
    const headers = await bearerHeaders();
    if (!headers) {
      setSendError("No active session — sign in again.");
      setSending(false);
      return;
    }
    try {
      const res = await fetch(`/api/match-chats/${chatId}/reply`, {
        method: "POST",
        headers,
        body: JSON.stringify({ body }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      setBody("");
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }, [body, chatId, sending]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void submit();
      }
    },
    [submit],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  // ---------------- header rendering ----------------
  const headerNodes = useMemo(() => {
    if (!validId) {
      return <span className="italic text-deep-green/55">Invalid chat id</span>;
    }
    if (!match) {
      return (
        <span className="italic text-deep-green/55">
          Match {chatId} · (no match data)
        </span>
      );
    }
    const city = match.city_identifier;
    return (
      <div className="flex flex-wrap items-baseline gap-1.5">
        {city && <CityChip code={city} size="sm" />}
        {match.start_date && (
          <>
            <Dot />
            <span className="font-semibold text-deep-green">
              {new Date(match.start_date).toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
              })}
            </span>
            <Dot />
            <span className="text-deep-green/70">
              {new Date(match.start_date).toLocaleTimeString(undefined, {
                hour: "numeric",
                minute: "2-digit",
              })}
            </span>
          </>
        )}
        <Dot />
        <span className="font-semibold text-deep-green">
          {match.field_title?.trim() || "(unknown venue)"}
        </span>
        {match.is_cancelled === true && (
          <span className="rounded-full bg-muted-soft px-1.5 py-0.5 text-[10px] font-medium text-muted">
            Cancelled
          </span>
        )}
      </div>
    );
  }, [validId, match, chatId]);

  return (
    <div className="-mx-6 -my-8 flex h-[calc(100vh-4rem)] flex-col bg-cream">
      <div className="border-b border-cream-line bg-cream px-6 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <Link
              href="/match-chats"
              className="text-xs text-deep-green/60 hover:underline"
            >
              ← All match chats
            </Link>
            <div className="mt-1">{headerNodes}</div>
            {match?.manager_email && (
              <div className="mt-1 text-[11px] text-deep-green/50">
                Manager:{" "}
                <span className="font-medium text-deep-green/70">
                  {match.manager_first_name} {match.manager_last_name}
                </span>{" "}
                · {match.manager_email}
              </div>
            )}
          </div>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto bg-cream-soft px-4 py-3">
        {matchError && (
          <div className="mb-2 rounded border border-coral/40 bg-coral-soft p-2 text-xs text-coral-hover">
            Match context: {matchError}
          </div>
        )}
        {listenError && (
          <div className="mb-2 rounded border border-coral/40 bg-coral-soft p-2 text-xs text-coral-hover">
            Realtime: {listenError}
          </div>
        )}

        {hasMore && messages.length > 0 && (
          <div className="mb-3 flex justify-center">
            <button
              type="button"
              onClick={() => void loadOlder()}
              disabled={loadingOlder}
              className="rounded-full border border-cream-line bg-white px-3 py-0.5 text-[11px] font-medium text-deep-green/70 transition hover:bg-cream-soft disabled:opacity-40"
            >
              {loadingOlder ? "Loading older messages…" : "Load older"}
            </button>
          </div>
        )}

        {session.status === "loading" && messages.length === 0 && (
          <div className="text-xs text-deep-green/50">
            Connecting to Firestore…
          </div>
        )}
        {session.status === "error" && (
          <div className="rounded border border-coral/40 bg-coral-soft p-2 text-xs text-coral-hover">
            Firestore: {session.error}
          </div>
        )}
        {session.status === "ready" && messages.length === 0 && (
          <div className="text-xs text-deep-green/50">
            No messages in this chat yet.
          </div>
        )}

        <ul className="space-y-2">
          {messages.map((m) => (
            <MessageRow key={m.__docId} msg={m} match={match} />
          ))}
        </ul>
      </div>

      <div className="border-t border-cream-line bg-white px-4 py-3">
        <textarea
          ref={taRef}
          value={body}
          disabled={sending}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Reply as MatchDay. Enter to send, Shift+Enter for newline."
          className="block w-full resize-none rounded-md border border-cream-line bg-white px-3 py-2 text-sm text-deep-green placeholder:text-deep-green/40 focus:border-deep-green focus:outline-none"
          style={{ minHeight: 80, maxHeight: 240 }}
        />
        <div className="mt-2 flex items-center justify-between text-xs text-deep-green/60">
          <div>
            <span className="font-medium text-deep-green">{body.length}</span>{" "}
            chars · posts as{" "}
            <span className="rounded-full bg-mint-soft px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-deep-green">
              MatchDay
            </span>
            {sendError && (
              <span className="ml-2 text-coral-hover">{sendError}</span>
            )}
          </div>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={sending || !body.trim()}
            className="rounded-full bg-deep-green px-3 py-1 text-xs font-medium text-cream transition hover:bg-deep-green-hover disabled:opacity-40"
          >
            {sending ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Dot() {
  return (
    <span aria-hidden className="text-deep-green/30">
      ·
    </span>
  );
}

function MessageRow({
  msg,
  match,
}: {
  msg: WireMessage;
  match: MatchContext | null;
}) {
  const kind = classifyMessage(msg);
  const isMatchDay = msg.sentBy === MATCHDAY_SENDER_NAME;
  const role = deriveSenderRole(msg, match);
  const iso = createdAtToIso(msg.createdAt) ?? "";

  return (
    <li
      className={`flex flex-col ${isMatchDay ? "items-end" : "items-start"}`}
    >
      <div className="mb-1 flex items-center gap-1.5">
        {!isMatchDay && (
          <span className="text-[11px] font-bold text-deep-green/70">
            {msg.sentBy || "(unknown)"}
          </span>
        )}
        <SenderBadge role={role} />
      </div>
      <div
        className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap ${
          isMatchDay
            ? "bg-mint text-deep-green"
            : "border border-cream-line bg-white text-deep-green"
        }`}
      >
        {kind !== "Text" && <MatchChatMessageMedia msg={msg} />}
        {kind !== "Text" && msg.text && (
          <div className="mt-1.5">{msg.text}</div>
        )}
        {kind === "Text" && (msg.text ?? "")}
      </div>
      <div className="mt-0.5 px-1 text-[10px] text-deep-green/45">
        {formatTimestamp(iso)}
      </div>
    </li>
  );
}

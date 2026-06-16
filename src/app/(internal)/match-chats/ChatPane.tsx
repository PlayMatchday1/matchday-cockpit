"use client";

// Right pane of the two-pane Match Chats shell. On mobile (< lg) this
// pane fills the screen when a chat is selected; a back chevron in
// the header returns to the inbox. On lg+ it sits alongside the inbox
// pane, and renders an empty state when no chat is selected.
//
// Differences from the legacy standalone /match-chats/[chatId] page:
//   - No page-level chrome. The shell owns layout.
//   - chatId arrives as a prop, not a route param. State resets on
//     change via a keyed effect.
//   - Header uses formatMatchTitle so the city-local time is correct.
//     Reads mdapi_matches.start_date_utc (the actually-UTC column).
//   - Realtime listener + Load Older pagination + composer behavior
//     are unchanged.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
import { ArrowUp, ChevronLeft, Megaphone } from "lucide-react";
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
import { formatMatchTitle, timezoneFor } from "@/lib/cityTimezones";
import Linkify from "linkify-react";
import { LINKIFY_OPTIONS } from "@/lib/linkify";
import NotifyPlayersDrawer from "./components/NotifyPlayersDrawer";

type MatchContext = {
  api_id: number;
  field_title: string | null;
  field_address: string | null;
  start_date_utc: string | null;
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

// ============================================================
// main
// ============================================================

export default function ChatPane({
  chatId,
  showOnMobile,
  onBack,
}: {
  chatId: string | null;
  showOnMobile: boolean;
  onBack: () => void;
}) {
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

  // Mobile visibility:
  //   showOnMobile=true  → flex flex-1, full-screen on mobile
  //   showOnMobile=false → hidden on mobile, but visible on lg+
  // On lg+ the pane is always visible.
  const visibility = `${
    showOnMobile ? "flex flex-1" : "hidden"
  } lg:flex lg:flex-1`;

  // Empty state — no selection. On mobile this is never reached
  // because the parent sets showOnMobile=false here, but the inner
  // `hidden lg:flex` belt-and-suspenders keeps it from ever showing
  // at narrow widths even if that contract changes.
  if (!chatId) {
    return (
      <section
        className={`min-w-0 flex-col items-center justify-center bg-white ${visibility}`}
      >
        <div className="hidden max-w-[32ch] flex-col items-center gap-2 px-6 text-center lg:flex">
          <div aria-hidden className="text-2xl opacity-70">
            💬
          </div>
          <div className="text-sm font-bold text-deep-green">
            Select a conversation
          </div>
          <div className="text-xs text-deep-green/55">
            Pick a match chat from the inbox to view messages and reply
            as MatchDay.
          </div>
        </div>
      </section>
    );
  }

  return (
    <ChatPaneInner
      chatId={chatId}
      session={session}
      visibility={visibility}
      onBack={onBack}
      match={match}
      setMatch={setMatch}
      matchError={matchError}
      setMatchError={setMatchError}
      messages={messages}
      setMessages={setMessages}
      oldestCursor={oldestCursor}
      setOldestCursor={setOldestCursor}
      hasMore={hasMore}
      setHasMore={setHasMore}
      loadingOlder={loadingOlder}
      setLoadingOlder={setLoadingOlder}
      listenError={listenError}
      setListenError={setListenError}
    />
  );
}

// Inner component so the outer one can guard on `chatId == null`
// before any hooks fire. (React's rules-of-hooks won't let us early-
// return between hook calls, so all state lives on the outer and is
// passed in.)
function ChatPaneInner({
  chatId,
  session,
  visibility,
  onBack,
  match,
  setMatch,
  matchError,
  setMatchError,
  messages,
  setMessages,
  oldestCursor,
  setOldestCursor,
  hasMore,
  setHasMore,
  loadingOlder,
  setLoadingOlder,
  listenError,
  setListenError,
}: {
  chatId: string;
  session: ReturnType<typeof useFirebaseSession>;
  visibility: string;
  onBack: () => void;
  match: MatchContext | null;
  setMatch: (m: MatchContext | null) => void;
  matchError: string | null;
  setMatchError: (s: string | null) => void;
  messages: WireMessage[];
  setMessages: React.Dispatch<React.SetStateAction<WireMessage[]>>;
  oldestCursor: DocumentSnapshot | null;
  setOldestCursor: (d: DocumentSnapshot | null) => void;
  hasMore: boolean;
  setHasMore: (b: boolean) => void;
  loadingOlder: boolean;
  setLoadingOlder: (b: boolean) => void;
  listenError: string | null;
  setListenError: (s: string | null) => void;
}) {
  const validId = isValidChatId(chatId);
  const [notifyOpen, setNotifyOpen] = useState(false);

  // Reset transient state when the chatId changes (user clicked a
  // different conversation).
  useEffect(() => {
    setMessages([]);
    setOldestCursor(null);
    setHasMore(true);
    setListenError(null);
    setMatch(null);
    setMatchError(null);
    // setters from useState are stable — exhaustive-deps disabled.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId]);

  // Match context.
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
  }, [chatId, setMatch, setMatchError]);

  // Realtime listener.
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
        setMessages((prev) => {
          const olderDocIds = new Set(
            prev.slice(MESSAGE_PAGE_SIZE).map((m) => m.__docId),
          );
          const fresh: WireMessage[] = snap.docs.map((d) => ({
            ...(d.data() as FirestoreMessage),
            __docId: d.id,
          }));
          const older = prev.filter((m) => olderDocIds.has(m.__docId));
          const combined = [...fresh, ...older].sort((a, b) => {
            const at = Date.parse(createdAtToIso(a.createdAt) ?? "") || 0;
            const bt = Date.parse(createdAtToIso(b.createdAt) ?? "") || 0;
            return at - bt;
          });
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
  }, [
    chatId,
    validId,
    session,
    setMessages,
    setOldestCursor,
    setHasMore,
    setListenError,
  ]);

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
  }, [
    chatId,
    hasMore,
    loadingOlder,
    oldestCursor,
    session,
    setHasMore,
    setLoadingOlder,
    setMessages,
    setOldestCursor,
  ]);

  // Compose
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    const next = Math.min(240, Math.max(44, ta.scrollHeight));
    ta.style.height = `${next}px`;
  }, [body]);

  // Reset compose state on chat switch.
  useEffect(() => {
    setBody("");
    setSendError(null);
  }, [chatId]);

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
  }, [messages.length, chatId]);

  // ---------------- header content ----------------
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
    const t = formatMatchTitle({
      cityCode: match.city_identifier,
      startDateIso: match.start_date_utc,
      fieldTitle: match.field_title,
    });
    return (
      <div className="flex min-w-0 flex-wrap items-baseline gap-1.5">
        {t.cityCode && <CityChip code={t.cityCode} size="sm" />}
        <Dot />
        <span className="font-semibold text-deep-green">{t.date}</span>
        {t.time && (
          <>
            <Dot />
            <span className="text-deep-green/70">{t.time}</span>
            {t.isUtcFallback && (
              <span className="text-[10px] text-deep-green/40">(UTC)</span>
            )}
          </>
        )}
        <Dot />
        <span className="truncate font-semibold text-deep-green">
          {t.venue}
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
    <section className={`min-w-0 flex-col bg-white ${visibility}`}>
      {/* Header — h-14 sticky, back chevron on mobile only */}
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-cream-line bg-white px-2 sm:px-4">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to inbox"
          style={{ touchAction: "manipulation" }}
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-deep-green/70 hover:bg-cream-soft hover:text-deep-green lg:hidden"
        >
          <ChevronLeft aria-hidden className="h-5 w-5" />
        </button>
        <div className="min-w-0 flex-1">
          {headerNodes}
          {match?.manager_email && (
            <div className="mt-0.5 truncate text-[10px] text-deep-green/50">
              Manager:{" "}
              <span className="font-medium text-deep-green/70">
                {match.manager_first_name} {match.manager_last_name}
              </span>{" "}
              · {match.manager_email}
            </div>
          )}
        </div>
        {validId && match && (
          <button
            type="button"
            onClick={() => setNotifyOpen(true)}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-cream-line px-3 py-1.5 text-xs font-bold text-deep-green hover:bg-cream-soft"
          >
            <Megaphone aria-hidden className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Notify players</span>
          </button>
        )}
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden bg-cream-soft px-4 py-3"
      >
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

      {/* Composer — round mint Send button inline with textarea,
          safe-area bottom padding so iOS home indicator clears. */}
      <div className="border-t border-cream-line bg-cream px-3 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] sm:px-4">
        <div className="flex items-end gap-2">
          <textarea
            ref={taRef}
            value={body}
            disabled={sending}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Reply as MatchDay. Enter to send, Shift+Enter for newline."
            // text-base (16px) so iOS doesn't auto-zoom on focus, which
            // strands the fixed bottom nav mid-screen. See Composer.tsx
            // for the full story.
            className="block flex-1 resize-none rounded-2xl border border-cream-line bg-white px-3 py-2 text-base text-deep-green placeholder:text-deep-green/40 focus:border-deep-green focus:outline-none disabled:bg-cream-soft disabled:text-deep-green/40"
            style={{ minHeight: 44, maxHeight: 240 }}
          />
          <button
            type="button"
            onClick={() => void submit()}
            disabled={sending || !body.trim()}
            aria-label={sending ? "Sending message" : "Send message"}
            style={{ touchAction: "manipulation" }}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-mint text-deep-green shadow-sm transition hover:bg-mint-hover disabled:opacity-40"
          >
            <ArrowUp aria-hidden className="h-5 w-5" strokeWidth={2.5} />
          </button>
        </div>
        <div className="mt-1.5 flex items-center justify-between text-[10px] text-deep-green/55">
          <div>
            <span className="font-medium text-deep-green/75">
              {body.length}
            </span>{" "}
            chars · posts as{" "}
            <span className="rounded-full bg-mint-soft px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-deep-green">
              MatchDay
            </span>
            {sendError && (
              <span className="ml-2 text-coral-hover">{sendError}</span>
            )}
          </div>
        </div>
      </div>

      <NotifyPlayersDrawer
        open={notifyOpen}
        onClose={() => setNotifyOpen(false)}
        chatId={chatId}
        match={match}
      />
    </section>
  );
}

// Helpers — same shape as the old ChatThreadClient versions.

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
          <div className="mt-1.5">
            <Linkify options={LINKIFY_OPTIONS}>{msg.text}</Linkify>
          </div>
        )}
        {kind === "Text" && (
          <Linkify options={LINKIFY_OPTIONS}>{msg.text ?? ""}</Linkify>
        )}
      </div>
      <div className="mt-0.5 px-1 text-[10px] text-deep-green/45">
        {formatTimestamp(iso)}
      </div>
    </li>
  );
}

// Unused locally but exported so the inbox can share the same
// timezone source (single source of truth for "this city → this
// IANA zone").
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _tzReferenceAnchor(x: typeof timezoneFor) {
  return x;
}

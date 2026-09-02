"use client";

// Thread pane of the Match Chats console (mockup matchops-chats-v1). Mist tone.
//
// Match-context header (venue, date/time, real player count, status) with a Veo
// action that renders ONLY when a Veo link is actually present in the loaded
// thread, plus Notify players. Messages are bottom-anchored (a short thread
// sits against the composer). The composer carries the verbatim WhatsApp line
// with the real participant count.
//
// "Open match" is intentionally omitted: there is no internal match-detail
// route and no shareable match URL stored on mdapi_matches (checked), so any
// such button would be a fabricated link. See ship report.
//
// Realtime listener, Load-older pagination, and reply/compose behaviour are
// carried over from the previous pane unchanged.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  collection,
  doc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  startAfter,
  type DocumentSnapshot,
  type QuerySnapshot,
} from "firebase/firestore";
import { supabase } from "@/lib/supabase";
import { useFirebaseSession } from "@/lib/useFirebaseSession";
import MatchChatMessageMedia from "@/components/MatchChatMessageMedia";
import {
  classifyMessage,
  createdAtToIso,
  isValidChatId,
  MATCHDAY_SENDER_NAME,
  MESSAGE_PAGE_SIZE,
  type FirestoreMessage,
} from "@/lib/matchChats";
import { formatMatchTitle } from "@/lib/cityTimezones";
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
  player_count: number | null;
  fake_player_count: number | null;
};

type WireMessage = FirestoreMessage & { __docId: string };

const VEO_URL_RE = /(https?:\/\/app\.veo\.co\/matches\/[^\s)]+)/i;
// A group-invite auto-post renders as a fact, never a raw chat.whatsapp.com
// link (S9). Matches the whole-message invite the bot posts on group create.
const WA_INVITE_RE = /chat\.whatsapp\.com/i;

// Real registered players = total registered minus synced fakes. Used for the
// header count and the composer "N real players" line. Null when unavailable
// → the composer line drops the count rather than inventing one.
function realPlayerCount(m: MatchContext | null): number | null {
  if (!m || m.player_count == null) return null;
  return Math.max(0, m.player_count - (m.fake_player_count ?? 0));
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { hour: "numeric", minute: "2-digit" });
}

async function bearerHeaders(): Promise<Record<string, string> | null> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return null;
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

// ============================================================
export default function ChatPane({
  chatId,
  showOnMobile,
  onBack,
  embedded = false,
}: {
  chatId: string | null;
  showOnMobile: boolean;
  onBack: () => void;
  /* EMBEDDED: this pane is inside the Gameday Ops side panel rather than the three-pane console.
   *
   * The console's visibility classes are built for that console — hidden below lg, and a
   * fixed inset-0 full-screen push on mobile. Both are wrong inside a panel that is already the
   * full-screen surface. Embedded just fills its parent at every width.
   *
   * ONE CHAT COMPONENT, ONE LOOKUP. The alternative was a second pane for the panel, which would
   * have meant two implementations of "which thread belongs to this match" — and that question
   * has exactly one answer (chatId is String(match.api_id)) which is already proven. */
  embedded?: boolean;
}) {
  // On mobile the open thread is a full-screen push that COVERS the bottom tab
  // bar (fixed inset-0), so the composer — not the tab bar — is the bottom
  // element and can own var(--sab). On desktop it stays an in-flow pane.
  const visibility = embedded
    ? "flex flex-1 min-h-0"
    : `${showOnMobile ? "fixed inset-0 z-40 flex" : "hidden"} lg:static lg:z-auto lg:flex lg:flex-1`;

  if (!chatId) {
    return (
      <section className={`min-w-0 flex-col items-center justify-center ${visibility}`} style={{ background: "#ffffff" }}>
        <div className={`${embedded ? "flex" : "hidden lg:flex"} max-w-[34ch] flex-col items-center gap-3.5 px-10 text-center`} data-testid="chatpane-empty">
          <div
            className="flex h-[52px] w-[52px] items-center justify-center rounded-full"
            style={{ background: "radial-gradient(circle at 35% 30%,#eafaf1,#d6efe1)", color: "#17724c", boxShadow: "0 0 0 7px rgba(224,242,231,.5)" }}
          >
            <svg viewBox="0 0 24 24" className="h-[22px] w-[22px]" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} aria-hidden>
              <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.9 8.9 0 0 1-3.8-.9L3 21l1.9-5.1A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4z" />
            </svg>
          </div>
          <h3 className="text-[15px] font-[730]" style={{ color: "#12241d" }}>
            Nothing selected
          </h3>
          <p className="text-[12.5px] leading-[1.6]" style={{ color: "#6d7b74" }}>
            Pick a chat on the left to read it and reply as MatchDay.
          </p>
        </div>
      </section>
    );
  }

  return <ChatPaneInner chatId={chatId} visibility={visibility} onBack={onBack} />;
}

function ChatPaneInner({
  chatId,
  visibility,
  onBack,
}: {
  chatId: string;
  visibility: string;
  onBack: () => void;
}) {
  const session = useFirebaseSession();
  const validId = isValidChatId(chatId);

  const [match, setMatch] = useState<MatchContext | null>(null);
  const [matchError, setMatchError] = useState<string | null>(null);
  const [messages, setMessages] = useState<WireMessage[]>([]);
  const [oldestCursor, setOldestCursor] = useState<DocumentSnapshot | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [listenError, setListenError] = useState<string | null>(null);
  const [notifyOpen, setNotifyOpen] = useState(false);

  // Reset on chat switch.
  useEffect(() => {
    setMessages([]);
    setOldestCursor(null);
    setHasMore(true);
    setListenError(null);
    setMatch(null);
    setMatchError(null);
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
        const j = (await res.json()) as { chat_id: string; match: MatchContext | null };
        if (!cancelled) setMatch(j.match);
      } catch (err) {
        if (!cancelled) setMatchError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chatId]);

  // Realtime listener.
  useEffect(() => {
    if (!validId || session.status !== "ready") return;
    const messagesRef = collection(doc(session.db, "Chats", chatId), "messages");
    const q = query(messagesRef, orderBy("createdAt", "desc"), limit(MESSAGE_PAGE_SIZE));
    const unsub = onSnapshot(
      q,
      (snap: QuerySnapshot) => {
        setMessages((prev) => {
          const olderIds = new Set(prev.slice(MESSAGE_PAGE_SIZE).map((m) => m.__docId));
          const fresh: WireMessage[] = snap.docs.map((d) => ({ ...(d.data() as FirestoreMessage), __docId: d.id }));
          const older = prev.filter((m) => olderIds.has(m.__docId));
          const combined = [...fresh, ...older].sort(
            (a, b) => (Date.parse(createdAtToIso(a.createdAt) ?? "") || 0) - (Date.parse(createdAtToIso(b.createdAt) ?? "") || 0),
          );
          const seen = new Set<string>();
          const out: WireMessage[] = [];
          for (const m of combined) {
            if (seen.has(m.__docId)) continue;
            seen.add(m.__docId);
            out.push(m);
          }
          return out;
        });
        if (snap.docs.length > 0) setOldestCursor(snap.docs[snap.docs.length - 1]);
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
    if (loadingOlder || !hasMore || !oldestCursor || session.status !== "ready") return;
    setLoadingOlder(true);
    try {
      const messagesRef = collection(doc(session.db, "Chats", chatId), "messages");
      const q = query(messagesRef, orderBy("createdAt", "desc"), startAfter(oldestCursor), limit(MESSAGE_PAGE_SIZE));
      const snap = await getDocs(q);
      if (snap.empty) {
        setHasMore(false);
      } else {
        const fresh: WireMessage[] = snap.docs.map((d) => ({ ...(d.data() as FirestoreMessage), __docId: d.id }));
        setMessages((prev) => {
          const all = [...fresh, ...prev].sort(
            (a, b) => (Date.parse(createdAtToIso(a.createdAt) ?? "") || 0) - (Date.parse(createdAtToIso(b.createdAt) ?? "") || 0),
          );
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

  // Compose.
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(150, Math.max(44, ta.scrollHeight))}px`;
  }, [body]);
  useEffect(() => {
    setBody("");
    setSendError(null);
  }, [chatId]);

  const submit = useCallback(async () => {
    if (sending || !body.trim()) return;
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
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, chatId]);

  const t = useMemo(
    () =>
      match
        ? formatMatchTitle({ cityCode: match.city_identifier, startDateIso: match.start_date_utc, fieldTitle: match.field_title })
        : null,
    [match],
  );
  const realN = realPlayerCount(match);
  const veoUrl = useMemo(() => {
    for (const m of messages) {
      const hit = m.text ? VEO_URL_RE.exec(m.text) : null;
      if (hit) return hit[1];
    }
    return null;
  }, [messages]);

  return (
    <section className={`min-w-0 flex-col ${visibility}`} style={{ background: "#ffffff" }}>
      {/* Header */}
      <div className="flex min-h-[64px] flex-none items-center gap-3 border-b px-3 sm:px-[22px]" style={{ borderColor: "#eff3f1", paddingTop: "var(--sat)" }}>
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to inbox"
          className="inline-flex h-9 w-9 flex-none items-center justify-center rounded-full lg:hidden"
          style={{ color: "#5c7267" }}
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} aria-hidden>
            <path d="M14 6l-6 6 6 6" />
          </svg>
        </button>

        {validId && match && t && (
          <span
            className="hidden h-[38px] w-[38px] flex-none items-center justify-center rounded-[12px] text-[10px] font-extrabold sm:flex"
            style={{ background: "#dceaf5", color: "#2f5d80" }}
          >
            {t.cityCode || "??"}
          </span>
        )}

        <div className="min-w-0 flex-1">
          {!validId ? (
            <span className="italic" style={{ color: "#6d7b74" }}>Invalid chat id</span>
          ) : !match ? (
            <span className="italic" style={{ color: "#6d7b74" }}>
              {matchError ? `Match ${chatId}` : `Match ${chatId} · (no match data)`}
            </span>
          ) : (
            <>
              <h2 className="truncate text-[16.5px] font-[730] tracking-[-0.014em]" style={{ color: "#12241d" }}>
                {t?.venue || "—"}
              </h2>
              <div className="mt-[3px] flex flex-wrap items-center gap-[7px] text-[12px]" style={{ color: "#6d7b74" }}>
                <b className="font-bold" style={{ color: "#3f544a" }}>
                  {t?.date}
                  {t?.time ? ` · ${t.time}` : ""}
                </b>
                {realN != null && (
                  <>
                    <Dot />
                    <span>{realN} player{realN === 1 ? "" : "s"}</span>
                  </>
                )}
                <Dot />
                <span style={{ color: match.is_cancelled ? "#8a6300" : "#12704a", fontWeight: 700 }}>
                  {match.is_cancelled ? "Cancelled" : "Scheduled"}
                </span>
              </div>
            </>
          )}
        </div>

        {validId && match && (
          <div className="flex flex-none items-center gap-1.5">
            {veoUrl && (
              <a
                href={veoUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex h-9 min-[900px]:h-8 items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-[650] transition hover:bg-[#eef3f0]"
                style={{ borderColor: "#e6ebe8", color: "#3f544a" }}
              >
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} aria-hidden>
                  <path d="M2.5 7.5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2z" />
                  <path d="M15.5 10.5l6-3.5v10l-6-3.5" />
                </svg>
                Veo
              </a>
            )}
            <button
              type="button"
              onClick={() => setNotifyOpen(true)}
              className="flex h-9 min-[900px]:h-8 items-center gap-1.5 rounded-full px-3.5 text-[12.5px] font-[650] transition"
              style={{ background: "#0d3b2e", color: "#eafaf1" }}
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} aria-hidden>
                <path d="M18 8.5a6 6 0 1 0-12 0c0 6-2.5 7.5-2.5 7.5h17S18 14.5 18 8.5z" />
                <path d="M10.3 20a2 2 0 0 0 3.4 0" />
              </svg>
              <span className="hidden sm:inline">Notify players</span>
            </button>
          </div>
        )}
      </div>

      {/* Messages — bottom-anchored */}
      <div
        ref={scrollRef}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden px-[22px] py-5 [&>*:first-child]:mt-auto"
        style={{ background: "radial-gradient(560px 260px at 88% -6%, rgba(53,199,127,.05), transparent 66%), #ffffff" }}
      >
        {matchError && (
          <div className="mb-2 rounded-lg border px-3 py-2 text-xs" style={{ borderColor: "#e3c369", background: "#fdf1d0", color: "#8a6300" }}>
            Match context: {matchError}
          </div>
        )}
        {listenError && (
          <div className="mb-2 rounded-lg border px-3 py-2 text-xs" style={{ borderColor: "#e3c369", background: "#fdf1d0", color: "#8a6300" }}>
            Realtime: {listenError}
          </div>
        )}
        {hasMore && messages.length > 0 && (
          <div className="mb-3 flex justify-center">
            <button
              type="button"
              onClick={() => void loadOlder()}
              disabled={loadingOlder}
              className="rounded-full border bg-white px-3 py-0.5 text-[11px] font-medium transition disabled:opacity-40"
              style={{ borderColor: "#e6ebe8", color: "#6d7b74" }}
            >
              {loadingOlder ? "Loading older messages…" : "Load older"}
            </button>
          </div>
        )}
        {session.status === "loading" && messages.length === 0 && (
          <div className="text-xs" style={{ color: "#93a49b" }}>Connecting to Firestore…</div>
        )}
        {session.status === "error" && (
          <div className="rounded-lg border px-3 py-2 text-xs" style={{ borderColor: "#e3c369", background: "#fdf1d0", color: "#8a6300" }}>
            Firestore: {session.error}
          </div>
        )}
        {session.status === "ready" && messages.length === 0 && (
          <div className="text-xs" style={{ color: "#93a49b" }}>No messages in this chat yet.</div>
        )}

        {messages.map((m) => (
          <MessageRow key={m.__docId} msg={m} />
        ))}
      </div>

      {/* Composer */}
      <div className="flex-none border-t px-[22px] py-3 pb-[calc(0.85rem+var(--sab))]" style={{ borderColor: "#eff3f1", background: "#ffffff" }}>
        <div
          className="mb-2.5 flex items-center gap-2 rounded-[9px] border px-[11px] py-1.5 text-[11.5px] font-semibold"
          style={{ background: "#fdf1d0", borderColor: "#e3c369", color: "#8a6300" }}
        >
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 flex-none" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} aria-hidden>
            <path d="M12 8.5v5" />
            <circle cx="12" cy="16.6" r=".9" fill="currentColor" stroke="none" />
            <path d="M10.3 3.9 2.5 17.4A2 2 0 0 0 4.2 20.5h15.6a2 2 0 0 0 1.7-3.1L13.7 3.9a2 2 0 0 0-3.4 0z" />
          </svg>
          <span>
            Sending as <b className="font-extrabold">MatchDay</b> to the WhatsApp group
            {realN != null ? (
              <>
                {" — "}
                <b className="font-extrabold">{realN} real player{realN === 1 ? "" : "s"}</b> will get this on their phones.
              </>
            ) : (
              "."
            )}
          </span>
        </div>

        <div
          className="overflow-hidden rounded-[15px] border transition focus-within:border-[#35c77f] focus-within:shadow-[0_0_0_3px_rgba(53,199,127,.14)]"
          style={{ background: "#ffffff", borderColor: "#e6ebe8" }}
        >
          <textarea
            ref={taRef}
            value={body}
            disabled={sending}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder={`Reply to ${t?.venue ?? "this group"}…`}
            className="block w-full resize-none border-0 bg-transparent px-3.5 pb-1 pt-3 text-[13.5px] leading-[1.5] outline-none"
            style={{ minHeight: 44, maxHeight: 150, color: "#243a31" }}
          />
          <div className="flex items-center gap-1.5 px-2.5 pb-2 pl-2.5 pt-1">
            <span className="text-[11px]" style={{ color: "#93a49b" }}>
              {body.length} chars
              {sendError && <span className="ml-2" style={{ color: "#8a6300" }}>{sendError}</span>}
            </span>
            <span className="flex-1" />
            <button
              type="button"
              onClick={() => void submit()}
              disabled={sending || !body.trim()}
              className="flex h-9 min-[900px]:h-[33px] items-center gap-1.5 rounded-full px-[15px] text-[13px] font-bold transition disabled:opacity-40"
              style={{ background: "#0d3b2e", color: "#eafaf1" }}
            >
              {sending ? "Sending…" : "Send"}
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} aria-hidden>
                <path d="M4 12h15" />
                <path d="M13 6l6 6-6 6" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      <NotifyPlayersDrawer open={notifyOpen} onClose={() => setNotifyOpen(false)} chatId={chatId} match={match} />
    </section>
  );
}

function Dot() {
  return <span aria-hidden className="inline-block h-[3px] w-[3px] rounded-full" style={{ background: "#c9d2cd" }} />;
}

function MessageRow({ msg }: { msg: WireMessage }) {
  const kind = classifyMessage(msg);
  const isMatchDay = msg.sentBy === MATCHDAY_SENDER_NAME;
  const iso = createdAtToIso(msg.createdAt) ?? "";
  const initials = (msg.sentBy || "?").slice(0, 2).toUpperCase();

  return (
    <div className={`mb-3 flex max-w-[74%] gap-2.5 ${isMatchDay ? "ml-auto flex-row-reverse" : ""}`}>
      <span
        className="mt-0.5 flex h-[27px] w-[27px] flex-none items-center justify-center rounded-full text-[10px] font-[750]"
        style={{ background: isMatchDay ? "#bff0d7" : "#e8eef0", color: "#2c4a3e" }}
      >
        {initials}
      </span>
      <div className="min-w-0">
        <div className={`mb-[3px] flex items-baseline gap-[7px] text-[11.5px] font-[750] ${isMatchDay ? "flex-row-reverse" : ""}`} style={{ color: isMatchDay ? "#12704a" : "#4a5f55" }}>
          <span>{msg.sentBy || "(unknown)"}</span>
          <span className="text-[10.5px] font-semibold" style={{ color: "#a8b4ae" }}>{formatTimestamp(iso)}</span>
        </div>
        <div
          className="whitespace-pre-wrap break-words px-[13px] py-[9px] text-[13.5px] leading-[1.5]"
          style={
            isMatchDay
              ? { background: "linear-gradient(170deg,#e6f7ee,#d9f1e5)", border: "1px solid #bfe6d1", borderRadius: "15px 4px 15px 15px", color: "#12352a" }
              : { background: "#eef3f0", border: "1px solid #e2eae5", borderRadius: "4px 15px 15px 15px", color: "#243a31" }
          }
        >
          {kind !== "Text" && <MatchChatMessageMedia msg={msg} />}
          {msg.text && WA_INVITE_RE.test(msg.text) ? (
            <span className="italic" style={{ color: "#5c7267" }}>Invite link posted by MatchDay</span>
          ) : (
            <>
              {kind !== "Text" && msg.text && (
                <div className="mt-1.5">
                  <Linkify options={LINKIFY_OPTIONS}>{msg.text}</Linkify>
                </div>
              )}
              {kind === "Text" && <Linkify options={LINKIFY_OPTIONS}>{msg.text ?? ""}</Linkify>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

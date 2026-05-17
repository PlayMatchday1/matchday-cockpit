"use client";

// Two-pane shell for /match-chats. Mirrors the /chats CrmClient
// pattern: deep-green title bar with the Players/Matches segmented
// control + live status + refresh, then a flex row of inbox + chat
// pane. On mobile (< lg) only one pane is visible at a time — the
// inbox until a chat is selected, the chat pane after, with a back
// arrow returning to the inbox.
//
// Inbox data fetch + Firestore realtime listener live here (not in
// the inbox component) so the header can surface live/offline state
// and Refresh without prop-drilling through the inbox.
//
// URL state owned here: ?chatId=… and ?tab=active|upcoming. Selecting
// a row updates the right pane in place via router.replace (no back-
// button noise per row click).

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
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
import PlayersMatchesToggle from "@/components/PlayersMatchesToggle";
import {
  ACTIVE_WINDOW_DAYS,
  isValidChatId,
  type MatchChatInboxResponse,
} from "@/lib/matchChats";
import MatchChatsInbox, { type InboxTab } from "./MatchChatsInbox";
import ChatPane from "./ChatPane";

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

function readTab(search: URLSearchParams): InboxTab {
  const raw = search.get("tab");
  return raw === "upcoming" ? "upcoming" : "active";
}

function readChatId(search: URLSearchParams): string | null {
  const raw = search.get("chatId");
  if (!raw) return null;
  // Numeric-id guard — refuses the 7 phantom non-numeric chats.
  return isValidChatId(raw) ? raw : null;
}

// ---------------- main ----------------

export default function MatchChatsClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const session = useFirebaseSession();

  const tab = useMemo(() => readTab(searchParams), [searchParams]);
  const selectedChatId = useMemo(
    () => readChatId(searchParams),
    [searchParams],
  );

  // Inbox data lifted up from MatchChatsInbox so the header can show
  // live/offline state and Refresh.
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

  // Lock document scroll while /match-chats is mounted. iOS Safari
  // standalone PWA scrolls the document when the keyboard opens and
  // does not restore scrollTop on dismiss. Same mechanism /chats uses.
  useEffect(() => {
    document.documentElement.classList.add("app-shell-locked");
    document.body.classList.add("app-shell-locked");
    return () => {
      document.documentElement.classList.remove("app-shell-locked");
      document.body.classList.remove("app-shell-locked");
    };
  }, []);

  // Write a single URL update preserving other params. router.replace
  // keeps us out of browser history.
  const updateParams = useCallback(
    (patch: { chatId?: string | null; tab?: InboxTab }) => {
      const next = new URLSearchParams(searchParams.toString());
      if ("chatId" in patch) {
        if (patch.chatId == null) next.delete("chatId");
        else next.set("chatId", patch.chatId);
      }
      if ("tab" in patch && patch.tab) {
        if (patch.tab === "active") next.delete("tab");
        else next.set("tab", patch.tab);
      }
      const qs = next.toString();
      router.replace(qs ? `/match-chats?${qs}` : "/match-chats", {
        scroll: false,
      });
    },
    [router, searchParams],
  );

  // Mobile flow rules:
  //   no selectedChatId             → inbox full-screen
  //   selectedChatId on mobile      → chat pane full-screen + back arrow
  //   selectedChatId on desktop     → both panes side-by-side
  const showInboxMobile = !selectedChatId;
  const showConversationMobile = !!selectedChatId;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-cream">
      <MatchChatsHeader session={session} onRefresh={() => void load()} />
      <div className="flex min-h-0 min-w-0 flex-1">
        <MatchChatsInbox
          data={data}
          error={error}
          loading={loading}
          selectedChatId={selectedChatId}
          tab={tab}
          onSelect={(chatId) => updateParams({ chatId })}
          onTabChange={(t) => updateParams({ tab: t })}
          showOnMobile={showInboxMobile}
        />
        <ChatPane
          chatId={selectedChatId}
          showOnMobile={showConversationMobile}
          onBack={() => updateParams({ chatId: null })}
        />
      </div>
    </div>
  );
}

// ============================================================
// Header — deep-green title bar with the Players/Matches segmented
// control on the left, live/offline + Refresh on the right. Matches
// /chats ChatsHeader chrome (bg-deep-green, min-h-12, safe-area-top
// padding via the SafeAreaInsetWatcher-backed CSS var).
// ============================================================
function MatchChatsHeader({
  session,
  onRefresh,
}: {
  session: ReturnType<typeof useFirebaseSession>;
  onRefresh: () => void;
}) {
  const liveLabel =
    session.status === "ready"
      ? "live"
      : session.status === "error"
        ? "offline"
        : "connecting";
  const liveDot =
    session.status === "ready"
      ? "bg-mint"
      : session.status === "error"
        ? "bg-coral"
        : "bg-muted";

  return (
    <header className="min-w-0 shrink-0">
      <div
        className="flex min-h-12 items-center justify-between gap-3 bg-deep-green px-3 sm:px-4"
        style={{ paddingTop: "var(--safe-area-top)" }}
      >
        <div className="min-w-0 max-w-[280px] flex-1">
          <PlayersMatchesToggle current="matches" />
        </div>
        <div className="flex shrink-0 items-center gap-2 text-[11px]">
          <span className="inline-flex items-center gap-1.5 text-cream/75">
            <span
              aria-hidden
              className={`inline-block h-1.5 w-1.5 rounded-full ${liveDot}`}
            />
            {liveLabel}
          </span>
          <button
            type="button"
            onClick={onRefresh}
            style={{ touchAction: "manipulation" }}
            className="rounded-full px-2 py-0.5 text-[11px] font-medium text-cream/85 transition hover:bg-deep-green-soft hover:text-cream"
          >
            Refresh
          </button>
        </div>
      </div>
    </header>
  );
}

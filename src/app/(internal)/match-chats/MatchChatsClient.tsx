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
import EnablePushNotificationsButton from "@/components/EnablePushNotificationsButton";
import PlayersMatchesToggle from "@/components/PlayersMatchesToggle";
import {
  ACTIVE_WINDOW_DAYS,
  isValidChatId,
  type MatchChatInboxResponse,
  type MatchChatInboxRow,
} from "@/lib/matchChats";
import { UNKNOWN_CITY } from "@/lib/cityColors";
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
  if (raw === "upcoming") return "upcoming";
  if (raw === "past") return "past";
  return "active";
}

function readChatId(search: URLSearchParams): string | null {
  const raw = search.get("chatId");
  if (!raw) return null;
  // Numeric-id guard — refuses the 7 phantom non-numeric chats.
  return isValidChatId(raw) ? raw : null;
}

function readCities(search: URLSearchParams): Set<string> {
  const raw = search.get("cities");
  if (!raw) return new Set();
  return new Set(raw.split(",").filter((c) => c.length > 0));
}

// Same city-filter rule the /chats Players inbox uses: empty set
// means "all cities" (no-op pass-through). Match rows with a null or
// empty city_identifier fall under UNKNOWN_CITY so the "Unknown" pill
// can pick them up. Orphan rows (match=null) also bucket as Unknown.
function filterByCities(
  rows: MatchChatInboxRow[],
  cities: Set<string>,
): MatchChatInboxRow[] {
  if (cities.size === 0) return rows;
  return rows.filter((r) => {
    const code = r.match?.city_identifier;
    const effective = code && code.length > 0 ? code : UNKNOWN_CITY;
    return cities.has(effective);
  });
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
  const cityFilter = useMemo(() => readCities(searchParams), [searchParams]);

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
    (patch: {
      chatId?: string | null;
      tab?: InboxTab;
      cities?: Set<string>;
    }) => {
      const next = new URLSearchParams(searchParams.toString());
      if ("chatId" in patch) {
        if (patch.chatId == null) next.delete("chatId");
        else next.set("chatId", patch.chatId);
      }
      if ("tab" in patch && patch.tab) {
        if (patch.tab === "active") next.delete("tab");
        else next.set("tab", patch.tab);
      }
      if (patch.cities !== undefined) {
        if (patch.cities.size === 0) next.delete("cities");
        else next.set("cities", [...patch.cities].join(","));
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

  // Apply city filter once per render. Counts on each tab reflect the
  // filtered rows (matching /chats's "{visible}" convention), so an
  // active city filter shrinks the tab counts in lockstep.
  const filteredActive = useMemo(
    () => filterByCities(data?.active ?? [], cityFilter),
    [data, cityFilter],
  );
  const filteredUpcoming = useMemo(
    () => filterByCities(data?.upcoming ?? [], cityFilter),
    [data, cityFilter],
  );
  const filteredPast = useMemo(
    () => filterByCities(data?.past ?? [], cityFilter),
    [data, cityFilter],
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-cream">
      <MatchChatsHeader
        session={session}
        onRefresh={() => void load()}
        loading={loading}
        activeCount={filteredActive.length}
        upcomingCount={filteredUpcoming.length}
      />
      <div className="flex min-h-0 min-w-0 flex-1">
        <MatchChatsInbox
          activeRows={filteredActive}
          upcomingRows={filteredUpcoming}
          pastRows={filteredPast}
          error={error}
          loading={loading}
          dataReady={data !== null}
          selectedChatId={selectedChatId}
          tab={tab}
          onSelect={(chatId) => updateParams({ chatId })}
          onTabChange={(t) => updateParams({ tab: t })}
          showOnMobile={showInboxMobile}
          cities={cityFilter}
          onCitiesChange={(c) => updateParams({ cities: c })}
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
// Header — mirrors /chats ChatsHeader (CrmClient.tsx) so the in-page
// header chrome reads the same on both routes:
//   1. Deep-green title bar with "Chats" h1
//   2. bg-cream segmented-control row (PlayersMatchesToggle)
//   3. Status line: tab counts + live + refresh
// /chats has a filter button in row 1 and a FilterBar row between 2
// and 3. /match-chats omits both (no filters on this surface); the
// title bar's right side stays empty so the min-h-12 still matches.
//
// Title bar is split into a safe-area spacer + content row stacked
// vertically so iOS Safari doesn't mis-center the content against
// the padding-top of a single combined div (PR #58 fix preserved).
// ============================================================
function MatchChatsHeader({
  session,
  onRefresh,
  loading,
  activeCount,
  upcomingCount,
}: {
  session: ReturnType<typeof useFirebaseSession>;
  onRefresh: () => void;
  loading: boolean;
  activeCount: number;
  upcomingCount: number;
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
  const countLabel = loading
    ? "Loading"
    : `${activeCount} active · ${upcomingCount} upcoming`;

  return (
    <header className="min-w-0 shrink-0">
      {/* Title bar — safe-area spacer + content row */}
      <div aria-hidden className="bg-deep-green" style={{ height: "var(--safe-area-top)" }} />
      <div className="flex min-h-12 items-center justify-between bg-deep-green px-3 sm:px-4">
        <h1 className="text-base font-bold tracking-tight text-cream">Chats</h1>
      </div>

      {/* Segmented control */}
      <div className="border-b border-cream-line bg-cream px-3 py-2 sm:px-4">
        <PlayersMatchesToggle current="matches" />
      </div>

      {/* Status line */}
      <div className="flex items-center justify-between gap-2 border-b border-cream-line bg-cream px-3 py-1 sm:px-4">
        <span className="text-[11px] text-deep-green/55">{countLabel}</span>
        <div className="flex items-center gap-2 text-[11px]">
          <span className="inline-flex items-center gap-1 text-deep-green/55">
            <span
              aria-hidden
              className={`inline-block h-1.5 w-1.5 rounded-full ${liveDot}`}
            />
            {liveLabel}
          </span>
          <EnablePushNotificationsButton />
          <button
            type="button"
            onClick={onRefresh}
            style={{ touchAction: "manipulation" }}
            className="rounded-full px-2 py-0.5 text-[11px] font-medium text-deep-green/70 transition hover:bg-cream-soft hover:text-deep-green"
          >
            Refresh
          </button>
        </div>
      </div>
    </header>
  );
}

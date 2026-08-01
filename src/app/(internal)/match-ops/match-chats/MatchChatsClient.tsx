"use client";

// Full-bleed three-pane Match Chats console (mockup matchops-chats-v1):
//   rail (212 / 60px)  ·  list (≈400px)  ·  thread (1fr)
//
// Owns: inbox fetch + Firestore realtime refetch, URL state (?chatId, ?tab,
// ?cities), rail-collapse (localStorage), and the client-side search box. The
// list and thread panes are presentational.
//
// The "Waiting on a reply" grouping is intentionally NOT shipped: there is no
// reliable stored field distinguishing an automated MatchDay post from a human
// message (the org posts under three sender identities, two of which are
// structurally identical to real players — see ship report / Step 1). The list
// is a single recency-ordered feed per tab. What we'd need to unblock it is a
// message-level direction/is_automated flag stamped at ingestion.

import { useCallback, useEffect, useMemo, useState } from "react";
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
import {
  ACTIVE_WINDOW_DAYS,
  isValidChatId,
  type MatchChatInboxResponse,
  type MatchChatInboxRow,
} from "@/lib/matchChats";
import { UNKNOWN_CITY } from "@/lib/cityColors";
import ChatsRail from "../ChatsRail";
import MatchChatsInbox, { type InboxTab } from "./MatchChatsInbox";
import ChatPane from "./ChatPane";

const RAIL_COLLAPSE_KEY = "cockpit:match-chats:rail-collapsed";

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
  return isValidChatId(raw) ? raw : null;
}

function readCities(search: URLSearchParams): Set<string> {
  const raw = search.get("cities");
  if (!raw) return new Set();
  return new Set(raw.split(",").filter((c) => c.length > 0));
}

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

// Client-side search over what's loaded: venue (field_title), the last
// message's sender name, and the last message body.
function filterBySearch(
  rows: MatchChatInboxRow[],
  q: string,
): MatchChatInboxRow[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((r) => {
    const hay = [
      r.match?.field_title ?? "",
      r.last_message?.sent_by ?? "",
      r.last_message?.body ?? "",
      r.chat_id,
    ]
      .join(" ")
      .toLowerCase();
    return hay.includes(needle);
  });
}

function readCollapse(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(RAIL_COLLAPSE_KEY) === "1";
  } catch {
    return false;
  }
}

// ---------------- main ----------------

export default function MatchChatsClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const session = useFirebaseSession();

  const tab = useMemo(() => readTab(searchParams), [searchParams]);
  const selectedChatId = useMemo(() => readChatId(searchParams), [searchParams]);
  const cityFilter = useMemo(() => readCities(searchParams), [searchParams]);

  const [data, setData] = useState<MatchChatInboxResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  // Rail collapse — persisted. Owned here so the grid column width and the rail
  // render stay in sync.
  const [railCollapsed, setRailCollapsed] = useState(false);
  useEffect(() => {
    setRailCollapsed(readCollapse());
  }, []);
  const toggleRail = useCallback(() => {
    setRailCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(RAIL_COLLAPSE_KEY, next ? "1" : "0");
      } catch {
        // private mode — no-op
      }
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
    const cutoff = new Date(Date.now() - ACTIVE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
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
        if (snap.docChanges().some((c) => c.type === "added")) void load();
      },
      (err) => {
        console.warn("[match-chats:inbox] realtime listener failed", err.message);
      },
    );
    return () => unsub();
  }, [session, load]);

  // Lock document scroll while the console is mounted (same as /chats).
  useEffect(() => {
    document.documentElement.classList.add("app-shell-locked");
    document.body.classList.add("app-shell-locked");
    return () => {
      document.documentElement.classList.remove("app-shell-locked");
      document.body.classList.remove("app-shell-locked");
    };
  }, []);

  const updateParams = useCallback(
    (patch: { chatId?: string | null; tab?: InboxTab; cities?: Set<string> }) => {
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
      router.replace(
        qs ? `/match-ops/match-chats?${qs}` : "/match-ops/match-chats",
        { scroll: false },
      );
    },
    [router, searchParams],
  );

  const showInboxMobile = !selectedChatId;
  const showConversationMobile = !!selectedChatId;

  // City filter first (tab counts reflect it, matching the old convention),
  // then search narrows the rendered rows within the active tab.
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

  const tabRows =
    tab === "active"
      ? filteredActive
      : tab === "upcoming"
        ? filteredUpcoming
        : filteredPast;
  const visibleRows = useMemo(
    () => filterBySearch(tabRows, search),
    [tabRows, search],
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1" style={{ background: "#f8faf9" }}>
      {/* Rail — desktop only */}
      <div
        className="hidden shrink-0 lg:block"
        style={{ width: railCollapsed ? 60 : 212, transition: "width .18s ease-out" }}
      >
        <ChatsRail collapsed={railCollapsed} onToggle={toggleRail} />
      </div>

      {/* List */}
      <MatchChatsInbox
        rows={visibleRows}
        activeCount={filteredActive.length}
        upcomingCount={filteredUpcoming.length}
        pastCount={filteredPast.length}
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
        search={search}
        onSearchChange={setSearch}
        sessionStatus={session.status}
        onRefresh={() => void load()}
      />

      {/* Thread */}
      <ChatPane
        chatId={selectedChatId}
        showOnMobile={showConversationMobile}
        onBack={() => updateParams({ chatId: null })}
      />
    </div>
  );
}

// GET /api/crm/threads?view=open|mine|starred|closed
//
// Ticket-style inbox. The active `view` is filtered SERVER-SIDE (the
// list is no longer a rolling 50-row window the client re-filters):
//   open    → status = 'open'
//   mine    → status = 'open' AND assigned_to_user_id = viewer
//   starred → viewer-starred threads, ANY status (open or closed)
//   closed  → status = 'closed'
// Default (missing / unknown param) is 'open'.
//
// The list is capped at LIST_LIMIT most-recent threads for the view.
// City filtering stays client-side (rows carry the player city) so
// toggling a city chip does not re-hit the server.
//
// Response:
//   { threads: ThreadListRow[],       // active view, newest first
//     counts:  { open, mine, starred, closed },   // global, server-side
//     index:   Array<{ city, status, mine, starred }> }  // for city-
//                                         // scoped counts on the client
//
// counts are the global per-view totals. The client displays them
// directly when no city is selected, and recomputes city-scoped counts
// from `index` (a lightweight all-threads projection) when city chips
// are active — matching "Open + DFW shows open threads in DFW".
//
// Auth: dual-mode bearer via src/lib/crmAuth. Cron callers (no viewer)
// get is_unread=false everywhere and empty mine/starred views.

import { authenticateCrm } from "@/lib/crmAuth";
import { UNKNOWN_CITY } from "@/lib/cityColors";

export const runtime = "nodejs";
export const maxDuration = 10;

const LIST_LIMIT = 100;
const INDEX_PAGE = 1000;

type ViewFilter = "open" | "mine" | "starred" | "closed";

function parseView(raw: string | null): ViewFilter {
  if (raw === "mine" || raw === "starred" || raw === "closed") return raw;
  return "open";
}

const THREAD_COLS =
  "id, phone_number, player_id, match_ambiguous, last_message_at, last_message_preview, created_at, assigned_to_user_id, assigned_at, channel, status, closed_at, closed_by_user_id";

type ThreadRow = {
  id: string;
  phone_number: string;
  player_id: number | null;
  match_ambiguous: boolean;
  last_message_at: string;
  last_message_preview: string | null;
  created_at: string;
  assigned_to_user_id: string | null;
  assigned_at: string | null;
  channel: "sms" | "whatsapp";
  status: "open" | "closed";
  closed_at: string | null;
  closed_by_user_id: string | null;
};

type PlayerRow = {
  id: number;
  first_name: string | null;
  last_name: string | null;
  preferable_city_normalized: string | null;
};

type AssigneeRow = {
  id: string;
  email: string;
  full_name: string | null;
};

export async function GET(req: Request) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }
  const { supabase, appUserId: viewerId } = auth;

  const url = new URL(req.url);
  const view = parseView(url.searchParams.get("view"));

  // The viewer's full star set (all threads, any status). Used for the
  // starred VIEW query, the per-row is_follow_up flag, and the starred
  // COUNT. Isolated: any failure leaves the set empty so the inbox
  // still loads with is_follow_up=false everywhere.
  const starredThreadIds = new Set<string>();
  if (viewerId) {
    try {
      const fr = await supabase
        .from("crm_thread_follow_ups")
        .select("thread_id")
        .eq("user_id", viewerId);
      if (fr.error) {
        console.error("[crm:threads.list] follow-up lookup error", fr.error);
      } else {
        for (const r of (fr.data ?? []) as { thread_id: string }[]) {
          starredThreadIds.add(r.thread_id);
        }
      }
    } catch (e) {
      console.error("[crm:threads.list] follow-up lookup threw", e);
    }
  }

  // ---------------- active-view list query ----------------
  let threads: ThreadRow[] = [];
  const emptyView =
    (view === "mine" && !viewerId) ||
    (view === "starred" && (!viewerId || starredThreadIds.size === 0));

  if (!emptyView) {
    let q = supabase.from("crm_threads").select(THREAD_COLS);
    if (view === "open") {
      q = q.eq("status", "open");
    } else if (view === "closed") {
      q = q.eq("status", "closed");
    } else if (view === "mine") {
      q = q.eq("status", "open").eq("assigned_to_user_id", viewerId!);
    } else {
      // starred — any status, restricted to the viewer's star set.
      q = q.in("id", Array.from(starredThreadIds));
    }
    const listRes = await q
      .order("last_message_at", { ascending: false })
      .limit(LIST_LIMIT);
    if (listRes.error) {
      console.error("[crm:threads.list] db error", listRes.error);
      return Response.json({ error: "DB error" }, { status: 500 });
    }
    threads = (listRes.data ?? []) as ThreadRow[];
  }

  // Batch-fetch players for the visible list.
  const playerIds = Array.from(
    new Set(
      threads
        .map((t) => t.player_id)
        .filter((x): x is number => typeof x === "number"),
    ),
  );
  let playersById = new Map<number, PlayerRow>();
  if (playerIds.length > 0) {
    const playersRes = await supabase
      .from("mdapi_users")
      .select("id, first_name, last_name, preferable_city_normalized")
      .in("id", playerIds);
    if (playersRes.error) {
      console.error("[crm:threads.list] player lookup error", playersRes.error);
    } else {
      playersById = new Map(
        (playersRes.data as PlayerRow[]).map((p) => [p.id, p]),
      );
    }
  }

  // Batch-fetch assignees for the visible list.
  const assigneeIds = Array.from(
    new Set(
      threads
        .map((t) => t.assigned_to_user_id)
        .filter((x): x is string => typeof x === "string"),
    ),
  );
  let assigneesById = new Map<string, AssigneeRow>();
  if (assigneeIds.length > 0) {
    const assigneesRes = await supabase
      .from("app_users")
      .select("id, email, full_name")
      .in("id", assigneeIds);
    if (assigneesRes.error) {
      console.error(
        "[crm:threads.list] assignee lookup error",
        assigneesRes.error,
      );
    } else {
      assigneesById = new Map(
        (assigneesRes.data as AssigneeRow[]).map((a) => [a.id, a]),
      );
    }
  }

  // Latest-message direction per visible thread. One bounded .limit(1)
  // query per thread (capped at LIST_LIMIT). Switch to a view or a
  // denormalized column if this shows up in slow logs.
  const directionResults = await Promise.all(
    threads.map(async (t) => {
      const r = await supabase
        .from("crm_messages")
        .select("direction")
        .eq("thread_id", t.id)
        .order("sent_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      return [t.id, r.data?.direction ?? null] as const;
    }),
  );
  const directionByThreadId = new Map<string, "inbound" | "outbound" | null>(
    directionResults,
  );

  // ---------------- read state (assignment-aware) ----------------
  const threadIds = threads.map((t) => t.id);
  const readsByThreadAll = new Map<string, string>(); // thread_id → MAX(last_read_at)
  const readsForViewer = new Map<string, string>(); // thread_id → viewer's last_read_at
  if (viewerId && threadIds.length > 0) {
    const readsRes = await supabase
      .from("crm_thread_reads")
      .select("thread_id, user_id, last_read_at")
      .in("thread_id", threadIds);
    if (readsRes.error) {
      console.error("[crm:threads.list] reads lookup error", readsRes.error);
    } else {
      for (const r of readsRes.data as {
        thread_id: string;
        user_id: string;
        last_read_at: string;
      }[]) {
        const prevMax = readsByThreadAll.get(r.thread_id);
        if (!prevMax || Date.parse(r.last_read_at) > Date.parse(prevMax)) {
          readsByThreadAll.set(r.thread_id, r.last_read_at);
        }
        if (r.user_id === viewerId) {
          readsForViewer.set(r.thread_id, r.last_read_at);
        }
      }
    }
  }

  function computeUnread(t: ThreadRow): boolean {
    if (!viewerId) return false;
    if (!t.last_message_preview) return false;
    if (directionByThreadId.get(t.id) !== "inbound") return false;
    let effective: string | null;
    if (t.assigned_to_user_id == null) {
      effective = readsByThreadAll.get(t.id) ?? null;
    } else if (t.assigned_to_user_id === viewerId) {
      effective = readsForViewer.get(t.id) ?? null;
    } else {
      return false;
    }
    if (effective == null) return true;
    return Date.parse(t.last_message_at) > Date.parse(effective);
  }

  const out = threads.map((t) => ({
    ...t,
    last_message_direction: directionByThreadId.get(t.id) ?? null,
    player: t.player_id != null ? playersById.get(t.player_id) ?? null : null,
    assignee:
      t.assigned_to_user_id != null
        ? assigneesById.get(t.assigned_to_user_id) ?? null
        : null,
    is_unread: computeUnread(t),
    is_follow_up: viewerId ? starredThreadIds.has(t.id) : false,
  }));

  // ---------------- counts + city index (all threads) ----------------
  // A lightweight projection of every thread drives the chip counts.
  // Paginated so it stays correct as closed threads accrue past 1000.
  const indexRows: {
    id: string;
    status: string | null;
    assigned_to_user_id: string | null;
    player_id: number | null;
  }[] = [];
  {
    let from = 0;
    // Cap total scan at a sane ceiling to bound worst case.
    while (from < 20000) {
      const r = await supabase
        .from("crm_threads")
        .select("id, status, assigned_to_user_id, player_id")
        .order("id", { ascending: true })
        .range(from, from + INDEX_PAGE - 1);
      if (r.error) {
        console.error("[crm:threads.list] index scan error", r.error);
        break;
      }
      const rows = (r.data ?? []) as typeof indexRows;
      indexRows.push(...rows);
      if (rows.length < INDEX_PAGE) break;
      from += INDEX_PAGE;
    }
  }

  // Player cities for the index (chunked IN queries).
  const idxPlayerIds = Array.from(
    new Set(
      indexRows
        .map((r) => r.player_id)
        .filter((x): x is number => typeof x === "number"),
    ),
  );
  const cityByPlayer = new Map<number, string | null>();
  for (let i = 0; i < idxPlayerIds.length; i += 1000) {
    const chunk = idxPlayerIds.slice(i, i + 1000);
    const cr = await supabase
      .from("mdapi_users")
      .select("id, preferable_city_normalized")
      .in("id", chunk);
    if (cr.error) {
      console.error("[crm:threads.list] index city lookup error", cr.error);
      continue;
    }
    for (const p of (cr.data ?? []) as {
      id: number;
      preferable_city_normalized: string | null;
    }[]) {
      cityByPlayer.set(p.id, p.preferable_city_normalized);
    }
  }

  function cityCodeFor(playerId: number | null): string {
    if (playerId == null) return UNKNOWN_CITY;
    const c = cityByPlayer.get(playerId);
    return c && c.length > 0 ? c : UNKNOWN_CITY;
  }

  const index = indexRows.map((r) => {
    const status = (r.status ?? "open") as "open" | "closed";
    return {
      city: cityCodeFor(r.player_id),
      status,
      mine:
        status === "open" &&
        !!viewerId &&
        r.assigned_to_user_id === viewerId,
      starred: starredThreadIds.has(r.id),
    };
  });

  const counts = {
    open: index.filter((r) => r.status === "open").length,
    mine: index.filter((r) => r.mine).length,
    starred: index.filter((r) => r.starred).length,
    closed: index.filter((r) => r.status === "closed").length,
  };

  return Response.json({ threads: out, counts, index }, { status: 200 });
}

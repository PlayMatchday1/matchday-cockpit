// GET /api/crm/threads?view=open|mine|starred|closed|awaiting
//
// Ticket-style inbox. The active `view` is filtered SERVER-SIDE (the
// list is no longer a rolling 50-row window the client re-filters):
//   open     → status = 'open'
//   mine     → status = 'open' AND assigned_to_user_id = viewer
//   starred  → viewer-starred threads, ANY status (open or closed)
//   closed   → status = 'closed'
//   awaiting → status = 'open' AND last_message_direction = 'inbound'
//              (customer spoke last), oldest first = longest waiting.
// Default (missing / unknown param) is 'open'. The open/mine lists are
// ordered awaiting-first so the client's Awaiting/Answered grouping is
// stable within the row cap.
//
// The list is capped at LIST_LIMIT most-recent threads for the view.
//
// Response:
//   { threads: ThreadListRow[],       // active view, ordered per above
//     counts:  { open, mine, starred, closed, awaiting } }  // global
//
// counts are the global per-view totals, derived from a lightweight
// all-threads scan of crm_threads. (City filtering was removed from the
// UI; the per-row city tag still comes from each thread's player.)
//
// Auth: dual-mode bearer via src/lib/crmAuth. Cron callers (no viewer)
// get is_unread=false everywhere and empty mine/starred views.

import { authenticateCrm } from "@/lib/crmAuth";

export const runtime = "nodejs";
export const maxDuration = 10;

const LIST_LIMIT = 100;
const INDEX_PAGE = 1000;

type ViewFilter = "open" | "mine" | "starred" | "closed" | "awaiting";

function parseView(raw: string | null): ViewFilter {
  if (
    raw === "mine" ||
    raw === "starred" ||
    raw === "closed" ||
    raw === "awaiting"
  )
    return raw;
  return "open";
}

const THREAD_COLS =
  "id, phone_number, player_id, match_ambiguous, last_message_at, last_message_preview, last_message_direction, last_message_is_template, created_at, assigned_to_user_id, assigned_at, channel, status, closed_at, closed_by_user_id";

type ThreadRow = {
  id: string;
  phone_number: string;
  player_id: number | null;
  match_ambiguous: boolean;
  last_message_at: string;
  last_message_preview: string | null;
  // Denormalized on crm_threads (migration 0071). 'inbound' = customer
  // spoke last → awaiting our reply; 'outbound' = we spoke last →
  // answered. Replaces the former per-thread N+1 lookup.
  last_message_direction: "inbound" | "outbound" | null;
  last_message_is_template: boolean;
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
    } else if (view === "awaiting") {
      // Awaiting = open threads where the customer spoke last.
      q = q.eq("status", "open").eq("last_message_direction", "inbound");
    } else {
      // starred — any status, restricted to the viewer's star set.
      q = q.in("id", Array.from(starredThreadIds));
    }

    // Ordering:
    //   awaiting          → oldest inbound first (longest waiting on top).
    //   open / mine       → awaiting rows first ('inbound' sorts before
    //                       'outbound'), so they can never be pushed past
    //                       the LIST_LIMIT cap by fresher answered
    //                       threads; the client then splits them into the
    //                       Awaiting / Answered groups and sorts each.
    //   starred / closed  → most-recent first (unchanged).
    if (view === "awaiting") {
      q = q.order("last_message_at", { ascending: true });
    } else if (view === "open" || view === "mine") {
      q = q
        .order("last_message_direction", { ascending: true, nullsFirst: false })
        .order("last_message_at", { ascending: false });
    } else {
      q = q.order("last_message_at", { ascending: false });
    }

    const listRes = await q.limit(LIST_LIMIT);
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

  // Latest-message direction now reads straight off the denormalized
  // crm_threads.last_message_direction column (migration 0071),
  // replacing the former per-thread N+1 into crm_messages.

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
    if (t.last_message_direction !== "inbound") return false;
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
    player: t.player_id != null ? playersById.get(t.player_id) ?? null : null,
    assignee:
      t.assigned_to_user_id != null
        ? assigneesById.get(t.assigned_to_user_id) ?? null
        : null,
    is_unread: computeUnread(t),
    is_follow_up: viewerId ? starredThreadIds.has(t.id) : false,
  }));

  // ---------------- global view counts (all threads) ----------------
  // A lightweight projection of every thread drives the chip counts.
  // Paginated so it stays correct as closed threads accrue past 1000.
  // No per-player city lookup: city filtering was removed from the UI,
  // so the counts are global and derive entirely from columns already
  // on crm_threads.
  const indexRows: {
    id: string;
    status: string | null;
    assigned_to_user_id: string | null;
    last_message_direction: string | null;
  }[] = [];
  {
    let from = 0;
    // Cap total scan at a sane ceiling to bound worst case.
    while (from < 20000) {
      const r = await supabase
        .from("crm_threads")
        .select("id, status, assigned_to_user_id, last_message_direction")
        .order("id", { ascending: true })
        .range(from, from + INDEX_PAGE - 1);
      if (r.error) {
        console.error("[crm:threads.list] count scan error", r.error);
        break;
      }
      const rows = (r.data ?? []) as typeof indexRows;
      indexRows.push(...rows);
      if (rows.length < INDEX_PAGE) break;
      from += INDEX_PAGE;
    }
  }

  const isOpen = (r: (typeof indexRows)[number]) =>
    (r.status ?? "open") === "open";
  const counts = {
    open: indexRows.filter(isOpen).length,
    mine: indexRows.filter(
      (r) => isOpen(r) && !!viewerId && r.assigned_to_user_id === viewerId,
    ).length,
    starred: indexRows.filter((r) => starredThreadIds.has(r.id)).length,
    closed: indexRows.filter((r) => (r.status ?? "open") === "closed").length,
    // Awaiting our reply = open + customer spoke last.
    awaiting: indexRows.filter(
      (r) => isOpen(r) && r.last_message_direction === "inbound",
    ).length,
  };

  return Response.json({ threads: out, counts }, { status: 200 });
}

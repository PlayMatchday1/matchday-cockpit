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
import { isAwaitingReply, waitingSinceMs } from "@/lib/awaitingReply";

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
  "id, phone_number, player_id, match_ambiguous, last_message_at, last_message_preview, last_message_direction, last_message_is_template, created_at, assigned_to_user_id, assigned_at, channel, status, closed_at, closed_by_user_id, no_reply_needed_at";

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
  // Operator "Done · no reply needed" dismissal (0073). Governs the
  // refined awaiting state alongside the acknowledgment heuristic.
  no_reply_needed_at: string | null;
};

type PlayerRow = {
  id: number;
  first_name: string | null;
  last_name: string | null;
  preferable_city_normalized: string | null;
  is_member: boolean | null;
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

  // ---------------- pill counts (fired concurrently) ----------------
  // Kicked off here — before the list query — so the counts run in
  // parallel with the list + enrichment and never delay the inbox
  // render (awaited only at the very end). These are the TRUE counts:
  //   • open / closed / mine → count-only queries (head:true, no row
  //     payloads), so nothing is derived from a capped fetch and no pill
  //     silently caps. (The FilterPill no longer shows "99+".)
  //   • starred → the viewer's star-set size, already in hand.
  //   • awaiting → can't be a pure count query (the acknowledgment /
  //     dismissal rule isn't PostgREST-expressible), so it's a bounded
  //     scan of the awaiting CANDIDATES only (open + inbound-last, a small
  //     set) filtered by the shared isAwaitingReply — the single source
  //     of truth, not double-computed. A failed count degrades to 0
  //     rather than failing the inbox.
  const awaitingCountP = (async (): Promise<number> => {
    const rows: {
      last_message_preview: string | null;
      last_message_at: string | null;
      no_reply_needed_at: string | null;
    }[] = [];
    let from = 0;
    while (from < 20000) {
      const r = await supabase
        .from("crm_threads")
        .select("last_message_preview, last_message_at, no_reply_needed_at")
        .eq("status", "open")
        .eq("last_message_direction", "inbound")
        .range(from, from + INDEX_PAGE - 1);
      if (r.error) {
        console.error("[crm:threads.list] awaiting count scan error", r.error);
        break;
      }
      const page = (r.data ?? []) as typeof rows;
      rows.push(...page);
      if (page.length < INDEX_PAGE) break;
      from += INDEX_PAGE;
    }
    return rows.filter((r) =>
      isAwaitingReply({
        status: "open",
        last_message_direction: "inbound",
        last_message_preview: r.last_message_preview,
        last_message_at: r.last_message_at,
        no_reply_needed_at: r.no_reply_needed_at,
      }),
    ).length;
  })();

  const countBase = () =>
    supabase.from("crm_threads").select("id", { count: "exact", head: true });
  const countsPromise = (async () => {
    const [openR, closedR, mineR, awaiting] = await Promise.all([
      countBase().eq("status", "open"),
      countBase().eq("status", "closed"),
      viewerId
        ? countBase().eq("status", "open").eq("assigned_to_user_id", viewerId)
        : Promise.resolve(null),
      awaitingCountP,
    ]);
    const num = (
      r: { count: number | null; error: unknown } | null,
    ): number => {
      if (!r) return 0;
      if (r.error) {
        console.error("[crm:threads.list] count query error", r.error);
        return 0;
      }
      return r.count ?? 0;
    };
    return {
      open: num(openR),
      closed: num(closedR),
      mine: num(mineR),
      starred: starredThreadIds.size,
      awaiting,
    };
  })();

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
      // Awaiting = open threads where the customer spoke last. The
      // acknowledgment / manual-dismissal refinement can't be expressed
      // in PostgREST, so this fetches the inbound-last set and the JS
      // post-filter below drops the "no reply needed" ones.
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

    // The dedicated Awaiting view returns ONLY genuinely-awaiting threads
    // — drop acknowledgments and operator-dismissed ones. (Open/Mine keep
    // the full set; the client splits them into Awaiting / Wrapping up /
    // Answered groups.)
    if (view === "awaiting") {
      threads = threads.filter((t) => isAwaitingReply(t));
    }
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
      .select("id, first_name, last_name, preferable_city_normalized, is_member")
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

  // ---------------- first-response waiting-since (awaiting rows) ----------------
  // The Chats row cue's SLA clock is anchored on the FIRST inbound of the
  // current unanswered run — the customer's continuous wait — scoped to the
  // current episode (latest reopen / auto_reopen, else thread creation). This
  // is deliberately NOT last_message_at: a customer sending three messages in a
  // row has waited since the first, and must not be able to reset the SLA by
  // following up. (The WhatsApp 24h window, computed CLIENT-side from
  // last_message_at, uses the OPPOSITE anchor on purpose — Meta's window really
  // does reopen on each inbound. See firstResponseCue.) Computed for awaiting
  // rows only; the client's crm_messages realtime handler maintains it after
  // load, so a follow-up inbound never needs a refetch.
  const awaitingIds = threads.filter((t) => isAwaitingReply(t)).map((t) => t.id);
  const waitingSinceByThread = new Map<string, string>();
  if (awaitingIds.length > 0) {
    // Episode start = latest reopen/auto_reopen per thread, else created_at.
    const episodeStartMs = new Map<string, number>();
    const logRes = await supabase
      .from("crm_thread_status_log")
      .select("thread_id, performed_at, action")
      .in("thread_id", awaitingIds)
      .in("action", ["reopen", "auto_reopen"]);
    if (logRes.error) {
      console.error("[crm:threads.list] status-log lookup error", logRes.error);
    } else {
      for (const r of (logRes.data ?? []) as {
        thread_id: string;
        performed_at: string;
      }[]) {
        const ms = Date.parse(r.performed_at);
        if (!Number.isFinite(ms)) continue;
        const prev = episodeStartMs.get(r.thread_id);
        if (prev == null || ms > prev) episodeStartMs.set(r.thread_id, ms);
      }
    }
    // Messages for the awaiting set (paged — a chatty thread can exceed 1000).
    const msgsByThread = new Map<
      string,
      { direction: "inbound" | "outbound"; sentAtMs: number; isAutoReply: boolean }[]
    >();
    let mFrom = 0;
    while (mFrom < 200_000) {
      const mr = await supabase
        .from("crm_messages")
        .select("thread_id, direction, sent_at, is_auto_reply")
        .in("thread_id", awaitingIds)
        .order("sent_at", { ascending: true })
        .range(mFrom, mFrom + INDEX_PAGE - 1);
      if (mr.error) {
        console.error("[crm:threads.list] message lookup error", mr.error);
        break;
      }
      const page = (mr.data ?? []) as {
        thread_id: string;
        direction: "inbound" | "outbound";
        sent_at: string;
        is_auto_reply: boolean | null;
      }[];
      for (const m of page) {
        const arr = msgsByThread.get(m.thread_id) ?? [];
        arr.push({
          direction: m.direction,
          sentAtMs: Date.parse(m.sent_at),
          isAutoReply: m.is_auto_reply === true,
        });
        msgsByThread.set(m.thread_id, arr);
      }
      if (page.length < INDEX_PAGE) break;
      mFrom += INDEX_PAGE;
    }
    for (const t of threads) {
      if (!awaitingIds.includes(t.id)) continue;
      const epStart = episodeStartMs.get(t.id) ?? Date.parse(t.created_at);
      const ms = waitingSinceMs(msgsByThread.get(t.id) ?? [], epStart);
      if (ms != null && Number.isFinite(ms)) {
        waitingSinceByThread.set(t.id, new Date(ms).toISOString());
      }
    }
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
    // First-response SLA anchor (Decision 2); null for non-awaiting rows.
    waiting_since: waitingSinceByThread.get(t.id) ?? null,
  }));

  // Counts were fired concurrently at the top; await the true values now.
  const counts = await countsPromise;

  return Response.json({ threads: out, counts }, { status: 200 });
}

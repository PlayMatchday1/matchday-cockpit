// GET /api/crm/threads — 50 most-recent threads for the left-pane
// list. Joined to mdapi_users for the display name + city chip, and
// to app_users for the current assignee chip.
//
// No pagination in MVP (cap = 50). Auth: dual-mode bearer via
// src/lib/crmAuth.
//
// Response shape:
//   { threads: Array<{
//       id, phone_number, player_id, match_ambiguous,
//       last_message_at, last_message_preview, last_message_direction,
//       assigned_to_user_id, assigned_at,
//       is_unread,                                  // per-viewer
//       player: { first_name, last_name, preferable_city_normalized } | null,
//       assignee: { id, email, full_name } | null
//     }> }
//
// is_unread is computed per the viewer per the assignment-aware
// resolution rule (see PR notes). Cron callers receive is_unread =
// false everywhere since there is no "viewer" to compare against —
// the unread dot is a human-facing UI signal only.
//
// last_message_direction is the direction of the most recent message
// in the thread ("inbound" | "outbound" | null). Used by the inbox
// to render a "You: " prefix when the last message was sent from
// Cockpit, matching the Slack/iMessage convention.

import { authenticateCrm } from "@/lib/crmAuth";

export const runtime = "nodejs";
export const maxDuration = 10;

const LIMIT = 50;

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

  const threadsRes = await supabase
    .from("crm_threads")
    .select(
      "id, phone_number, player_id, match_ambiguous, last_message_at, last_message_preview, created_at, assigned_to_user_id, assigned_at, channel",
    )
    .order("last_message_at", { ascending: false })
    .limit(LIMIT);
  if (threadsRes.error) {
    console.error("[crm:threads.list] db error", threadsRes.error);
    return Response.json({ error: "DB error" }, { status: 500 });
  }
  const threads = (threadsRes.data ?? []) as ThreadRow[];

  // Batch-fetch players in one IN() query rather than per-thread.
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

  // Same batch trick for assignees.
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

  // Latest-message direction per thread. PostgREST has no native
  // "DISTINCT ON" so we issue one bounded query per thread in
  // parallel rather than pulling the full message history. At 50
  // threads this is one round of cheap .limit(1) queries; switch to
  // a view or DB-maintained denormalized column if this ever shows
  // up in slow logs.
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

  // ---------------- Read state (assignment-aware) ----------------
  // For each thread in the result set, compute is_unread for the
  // viewer:
  //
  //   thread.assigned_to_user_id IS NULL → effective_last_read_at
  //                                         = MAX(reads.last_read_at)
  //                                           across all admins
  //   thread.assigned_to_user_id  = viewer
  //                                       → effective_last_read_at
  //                                         = the assignee's row
  //   thread.assigned_to_user_id  != viewer
  //                                       → is_unread = false
  //                                         (out of responsibility;
  //                                         non-assignees never see
  //                                         a dot for assigned
  //                                         threads)
  //
  //   is_unread = (effective IS NULL OR last_message_at > effective)
  //               AND last_message_preview IS NOT NULL
  //
  // Cron path (viewerId === null) gets is_unread = false on every
  // row — no human viewer, no dot to show.
  const threadIds = threads.map((t) => t.id);
  let readsByThreadAll = new Map<string, string>(); // thread_id → MAX(last_read_at)
  let readsForViewer = new Map<string, string>(); // thread_id → viewer's last_read_at
  if (viewerId && threadIds.length > 0) {
    // Pull all read rows for the visible thread set. Cap is 50
    // threads × N admins (~few hundred rows at current volume).
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
    // Cron / no viewer → no human-facing dot to show.
    if (!viewerId) return false;
    // No message preview → empty inbox, no dot.
    if (!t.last_message_preview) return false;
    let effective: string | null;
    if (t.assigned_to_user_id == null) {
      effective = readsByThreadAll.get(t.id) ?? null;
    } else if (t.assigned_to_user_id === viewerId) {
      effective = readsForViewer.get(t.id) ?? null;
    } else {
      // Assigned to someone else → never unread for this viewer.
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
  }));

  return Response.json({ threads: out }, { status: 200 });
}

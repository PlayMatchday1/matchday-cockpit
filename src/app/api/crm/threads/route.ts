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
//       last_message_at, last_message_preview,
//       assigned_to_user_id, assigned_at,
//       player: { first_name, last_name, preferable_city_normalized } | null,
//       assignee: { id, email, full_name } | null
//     }> }

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
  const { supabase } = auth;

  const threadsRes = await supabase
    .from("crm_threads")
    .select(
      "id, phone_number, player_id, match_ambiguous, last_message_at, last_message_preview, created_at, assigned_to_user_id, assigned_at",
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

  const out = threads.map((t) => ({
    ...t,
    player: t.player_id != null ? playersById.get(t.player_id) ?? null : null,
    assignee:
      t.assigned_to_user_id != null
        ? assigneesById.get(t.assigned_to_user_id) ?? null
        : null,
  }));

  return Response.json({ threads: out }, { status: 200 });
}

// GET /api/match-chats/active — inbox data for /match-chats.
//
// Returns two sections:
//   1. "active"   — chats with >= 1 message in the last 7 days,
//                   newest message first.
//   2. "upcoming" — matches starting in the next 3 days that are NOT
//                   cancelled AND don't already appear in active
//                   (dedupe on chat_id). Soonest first.
//
// Both lists are joined to mdapi_matches for the venue/city/manager
// display payload. Orphans (Firestore chat with no matching
// mdapi_matches row) are returned with match=null and the UI renders
// "Match {id} · (no match data)".
//
// Why server-side: the active-list discovery is a Firestore
// collection-group query that fans out across all 3,200+ chats —
// not something we want to do from every client. The detail-view
// listener is still client-side (real-time SDK), but the inbox shape
// is computed here and refreshed per page-load.
//
// Auth: admin-only via src/lib/crmAuth.

import { authenticateCrm } from "@/lib/crmAuth";
import { firestore } from "@/lib/firebaseAdmin";
import {
  ACTIVE_WINDOW_DAYS,
  UPCOMING_WINDOW_DAYS,
  isValidChatId,
  type MatchChatInboxResponse,
  type MatchChatInboxRow,
} from "@/lib/matchChats";

export const runtime = "nodejs";
export const maxDuration = 30;

// Soft cap on the collection-group sweep. 500 messages is enough to
// capture ~7 days of activity across all active chats in current
// volume; if we ever blow through this we'll see truncation and can
// raise it (or move to cursor pagination).
const ACTIVE_CG_LIMIT = 500;

// Hard cap on returned inbox rows. Same logic as the CRM 50-thread
// cap — operators chase the freshest items; tail goes to a future
// pagination pass.
const SECTION_CAP = 100;

type MatchRow = {
  api_id: number;
  field_title: string | null;
  // The actually-UTC column on mdapi_matches. See PR notes — the
  // sibling `start_date` column is mislabeled (local wall-clock with
  // a spurious +00 offset).
  start_date_utc: string | null;
  city_identifier: string | null;
  manager_email: string | null;
  is_cancelled: boolean | null;
};

export async function GET(req: Request) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }
  const { supabase } = auth;

  const db = firestore();

  // ---------------- Section 1: Active ----------------
  const cutoffMs = Date.now() - ACTIVE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const cutoffTs = new Date(cutoffMs);

  // Collection-group sweep across every Chats/*/messages subcoll.
  // We dedupe by parent chat id on the fly to keep working memory
  // bounded. Order by createdAt desc → first hit per chat IS its
  // newest message.
  type ActiveAccum = {
    chat_id: string;
    last_message_at: string;
    last_message_text: string | null;
    last_message_sent_by: string | null;
  };
  const activeByChat = new Map<string, ActiveAccum>();

  let truncated = false;
  try {
    const snap = await db
      .collectionGroup("messages")
      .where("createdAt", ">=", cutoffTs)
      .orderBy("createdAt", "desc")
      .limit(ACTIVE_CG_LIMIT)
      .get();

    truncated = snap.size === ACTIVE_CG_LIMIT;

    for (const doc of snap.docs) {
      const parentId = doc.ref.parent.parent?.id;
      if (!parentId || !isValidChatId(parentId)) continue;
      if (activeByChat.has(parentId)) continue;
      const data = doc.data() as {
        createdAt?: { toDate?: () => Date };
        text?: string | null;
        sentBy?: string | null;
      };
      const sentIso =
        data.createdAt?.toDate?.()?.toISOString() ?? new Date().toISOString();
      activeByChat.set(parentId, {
        chat_id: parentId,
        last_message_at: sentIso,
        last_message_text:
          typeof data.text === "string" ? data.text : null,
        last_message_sent_by:
          typeof data.sentBy === "string" ? data.sentBy : null,
      });
      if (activeByChat.size >= SECTION_CAP) break;
    }
  } catch (err) {
    const e = err as { code?: number; message?: string };
    console.error(
      "[match-chats:active] CG query failed — missing index?",
      e.code,
      e.message,
    );
    return Response.json(
      {
        error:
          "Active-chats query failed — likely a missing single-field collection-group index on (messages, createdAt). Create the exemption in Firebase Console → Firestore → Indexes.",
      },
      { status: 503 },
    );
  }

  const activeChatIds = [...activeByChat.keys()];

  // ---------------- Section 2: Upcoming ----------------
  // Matches starting in the next UPCOMING_WINDOW_DAYS, not cancelled,
  // not already in active.
  const nowIso = new Date().toISOString();
  const upperMs = Date.now() + UPCOMING_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const upperIso = new Date(upperMs).toISOString();

  const upcomingRes = await supabase
    .from("mdapi_matches")
    .select(
      "api_id, field_title, start_date_utc, city_identifier, manager_email, is_cancelled",
    )
    .gte("start_date_utc", nowIso)
    .lt("start_date_utc", upperIso)
    .neq("is_cancelled", true)
    .order("start_date_utc", { ascending: true })
    .limit(SECTION_CAP);
  if (upcomingRes.error) {
    console.error(
      "[match-chats:active] upcoming query failed",
      upcomingRes.error,
    );
    return Response.json({ error: "DB error" }, { status: 500 });
  }
  const upcomingRows = (upcomingRes.data ?? []) as MatchRow[];
  const upcomingFiltered = upcomingRows.filter(
    (m) => !activeByChat.has(String(m.api_id)),
  );

  // ---------------- Join: fetch mdapi_matches for active IDs ----------------
  const activeMatchById = new Map<string, MatchRow>();
  if (activeChatIds.length > 0) {
    const idsNum = activeChatIds
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n));
    if (idsNum.length > 0) {
      const r = await supabase
        .from("mdapi_matches")
        .select(
          "api_id, field_title, start_date_utc, city_identifier, manager_email, is_cancelled",
        )
        .in("api_id", idsNum);
      if (r.error) {
        console.error("[match-chats:active] match join failed", r.error);
      } else {
        for (const m of r.data as MatchRow[]) {
          activeMatchById.set(String(m.api_id), m);
        }
      }
    }
  }

  // ---------------- Shape responses ----------------
  const active: MatchChatInboxRow[] = activeChatIds.map((id) => {
    const accum = activeByChat.get(id)!;
    const m = activeMatchById.get(id) ?? null;
    return {
      section: "active",
      chat_id: id,
      match: m
        ? {
            api_id: m.api_id,
            field_title: m.field_title,
            start_date_utc: m.start_date_utc,
            city_identifier: m.city_identifier,
            manager_email: m.manager_email,
            is_cancelled: m.is_cancelled === true,
          }
        : null,
      last_message: {
        sent_at: accum.last_message_at,
        body: accum.last_message_text,
        sent_by: accum.last_message_sent_by,
      },
    };
  });

  const upcoming: MatchChatInboxRow[] = upcomingFiltered.map((m) => ({
    section: "upcoming",
    chat_id: String(m.api_id),
    match: {
      api_id: m.api_id,
      field_title: m.field_title,
      start_date_utc: m.start_date_utc,
      city_identifier: m.city_identifier,
      manager_email: m.manager_email,
      is_cancelled: m.is_cancelled === true,
    },
    last_message: null,
  }));

  if (truncated) {
    console.warn(
      `[match-chats:active] CG sweep hit cap (${ACTIVE_CG_LIMIT}). Some active chats may be missing.`,
    );
  }

  const body: MatchChatInboxResponse = { active, upcoming };
  return Response.json(body, { status: 200 });
}

// POST /api/crm/threads/[id]/ai-draft — Claude drafts a reply for this thread (phase 1).
//
// Body: { regenerate?: boolean }
//
// Called by the draft card when someone opens a thread whose latest message is from the player.
// Returns a draft for a human to Use, edit or Discard. NOTHING IS SENT FROM HERE: the only way a
// draft reaches a player is a staff member pressing the existing Send, which goes through
// /api/crm/send exactly as a typed reply does.
//
// Auth: authenticateCrm — anyone with can_access_chats (or is_admin). No new right (Ryan,
// 2026-10-20). A city-confined account gets the same city check the context route applies.
//
// The decisions (skip, reuse, cap, guards) live in src/lib/aiDraftRun.ts and are tested there
// with fakes; src/lib/aiDraftDeps.ts wires them to Supabase, the MatchDay profile read and the
// Anthropic API, and this file adds the person asking.
// Key: ANTHROPIC_API_KEY, server-side only. Model: claude-sonnet-5-5 at medium effort.

import { authenticateCrm } from "@/lib/crmAuth";
import { runDraft } from "@/lib/aiDraftRun";
import { draftDataDeps } from "@/lib/aiDraftDeps";
import { creditsGate } from "@/lib/creditsAuth";
import { can, denial } from "@/lib/capabilities";
import type { AppUserRow } from "@/lib/adminAuth";

export const runtime = "nodejs";
export const maxDuration = 60;

type RouteCtx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: RouteCtx) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { supabase } = auth;
  const { id: threadId } = await ctx.params;
  if (!threadId) return Response.json({ error: "id required" }, { status: 400 });
  const body = (await req.json().catch(() => ({}))) as { regenerate?: unknown };
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();

  const result = await runDraft({
    threadId,
    requestedBy: auth.appUserId,
    regenerate: body.regenerate === true,
    now: () => Date.now(),
    hasKey: !!apiKey,

    ...draftDataDeps({ supabase, threadId, requestedBy: auth.appUserId, confinedCity: auth.confinedCity, apiKey }),
  }).catch((e: unknown) => {
    console.error("[ai-draft] failed", e instanceof Error ? e.message.slice(0, 200) : e);
    return { status: "failed" as const, draft_id: null, message: "Something went wrong making a draft." };
  });

  console.log(`[ai-draft] thread=${threadId} status=${result.status}${"reused" in result ? ` reused=${result.reused}` : ""}`);
  const http = result.status === "forbidden" ? 403 : result.status === "not_found" ? 404 : 200;

  // Whether THIS person may press the button: a courtesy for the card. The action route checks again.
  let action_refusal: string | null = null;
  if (result.status === "ok" && result.draft.action) {
    const u = await supabase.from("app_users").select("*").eq("id", auth.appUserId ?? "").maybeSingle();
    const row = (u.data as AppUserRow | null) ?? null;
    if (!row) action_refusal = "Not a cockpit user.";
    else if (result.draft.action.kind === "credit") {
      const g = creditsGate(row);
      action_refusal = g.ok ? null : g.error;
    } else if (!can(row, "managePromos", auth.email ?? "")) {
      action_refusal = denial(row, "managePromos", auth.email ?? "") ?? "You do not hold MANAGE PROMOS.";
    }
  }
  return Response.json({ ...result, action_refusal }, { status: http, headers: { "cache-control": "no-store" } });
}

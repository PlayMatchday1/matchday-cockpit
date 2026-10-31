// POST /api/crm/threads/[id]/ai-draft/action — a staff member pressed a draft's action button.
//
// Body: { draft_id: string }. Nothing else: what happens is what was stored and guarded on the draft.
//
// Sends nothing. It returns the reply text for the card to put in the reply box, and only if the write
// landed. The writes go through the credit and promo routes' own POST handlers, called with this
// caller's Authorization, so each route's gate, race check, host guard and recordWrite run exactly as
// they do for the Player Lookup credit box and Promo Codes. There is no second write path.
//
// Auth: authenticateCrm for the chats gate, then the same right the target route will re-check itself
// (EDIT CREDITS or MANAGE PROMOS). Decisions live in src/lib/aiDraftAction.ts.

import { authenticateCrm } from "@/lib/crmAuth";
import { FULL_EDITOR_ENV } from "@/lib/matchEnv";
import { creditsGate } from "@/lib/creditsAuth";
import { can, denial } from "@/lib/capabilities";
import type { AppUserRow } from "@/lib/adminAuth";
import { loadGuestFacts } from "@/lib/aiDraftGuest";
import {
  applyDraftAction, guestCodeBody, guestCodeFor, guestCodeRefusal, writeStatusFrom,
  DRAFT_ACTION_SOURCE, type ActionDraft, type WriteResult,
} from "@/lib/aiDraftAction";
import { POST as creditPOST } from "@/app/api/matchday/[env]/players/[playerId]/credits/route";
import { POST as promoPOST } from "@/app/api/promos/create/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type RouteCtx = { params: Promise<{ id: string }> };
const ENV = FULL_EDITOR_ENV;

export async function POST(req: Request, ctx: RouteCtx) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { supabase } = auth;
  const { id: threadId } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { draft_id?: unknown };
  const draftId = typeof body.draft_id === "string" ? body.draft_id : "";
  if (!threadId || !draftId) return Response.json({ error: "thread id and draft_id required" }, { status: 400 });
  const authorization = req.headers.get("authorization") ?? "";

  const postTo = async (handler: (r: Request) => Promise<Response>, path: string, payload: unknown): Promise<WriteResult> => {
    const res = await handler(new Request(new URL(path, req.url), {
      method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify(payload),
    }));
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: writeStatusFrom(res.status, j), error: typeof j.error === "string" ? j.error : undefined };
  };

  const result = await applyDraftAction({
    threadId,
    async loadDraft() {
      const r = await supabase.from("crm_ai_drafts").select("id, thread_id, outcome, draft_text, action, action_status").eq("id", draftId).maybeSingle();
      if (r.error) throw new Error(r.error.message);
      return (r.data as ActionDraft | null) ?? null;
    },
    async threadPlayerId() {
      const r = await supabase.from("crm_threads").select("player_id").eq("id", threadId).maybeSingle();
      if (r.error) throw new Error(r.error.message);
      return (r.data?.player_id as number | null) ?? null;
    },
    async rightsRefusal(kind) {
      // select("*"), as adminAuth does: permission columns are never named.
      const r = await supabase.from("app_users").select("*").eq("id", auth.appUserId ?? "").maybeSingle();
      const row = (r.data as AppUserRow | null) ?? null;
      if (!row) return "Not a cockpit user.";
      if (kind === "credit") {
        const g = creditsGate(row);
        return g.ok ? null : g.error;
      }
      return can(row, "managePromos", auth.email ?? "") ? null : denial(row, "managePromos", auth.email ?? "") ?? "You do not hold MANAGE PROMOS.";
    },
    async guestPreflight(playerId) {
      const f = await loadGuestFacts({ supabase, env: ENV, playerId, threadId, confinedCity: auth.confinedCity });
      if (!f.ok) return f;
      const no = guestCodeRefusal(f.facts);
      return no ? { ok: false, error: no } : { ok: true, code: guestCodeFor(f.facts.slug!) };
    },
    async claim() {
      const r = await supabase.from("crm_ai_drafts")
        .update({ action_status: "applying", action_at: new Date().toISOString(), action_by_user_id: auth.appUserId })
        .eq("id", draftId).eq("outcome", "pending").is("action_status", null).select("id");
      if (r.error) throw new Error(r.error.message);
      return (r.data ?? []).length === 1;
    },
    writeCredit: ({ playerId, deltaCents, expectedBeforeCents, reason }) =>
      postTo(
        (r) => creditPOST(r, { params: Promise.resolve({ env: ENV, playerId: String(playerId) }) }),
        `/api/matchday/${ENV}/players/${playerId}/credits`,
        { deltaCents, expectedBeforeCents, reason, source: DRAFT_ACTION_SOURCE },
      ),
    writeGuestCode: (code) => postTo(promoPOST, "/api/promos/create", guestCodeBody(code, Date.now())),
    async finish(status, draftText) {
      const r = await supabase.from("crm_ai_drafts").update({ action_status: status, ...(draftText ? { draft_text: draftText } : {}) }).eq("id", draftId);
      if (r.error) throw new Error(r.error.message);
    },
  }).catch((e: unknown) => {
    console.error("[ai-draft] action failed", e instanceof Error ? e.message.slice(0, 200) : e);
    return { ok: false as const, httpStatus: 500, status: "unknown" as const, error: "Something went wrong. Check Player Lookup before doing this again." };
  });

  if (result.ok) return Response.json(result);
  return Response.json({ ok: false, status: result.status, error: result.error }, { status: result.httpStatus });
}

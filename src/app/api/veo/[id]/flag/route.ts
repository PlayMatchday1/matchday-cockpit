/* PATCH /api/veo/[id]/flag — a person says an inferred placement was right.
 *
 * WHY THIS EXISTS. The page's own copy said a flagged film "is still on the flagged list until
 * somebody says it is right", and there was no way to say it: the Confirm control was `disabled`
 * and no route stood behind it. With flagged rows now grouped into "Needs you", that would have
 * been a list that could only ever grow.
 *
 * IT IS ONE BOOLEAN. `flagged` goes false. Nothing else on the row is touched — not video_url, not
 * matched_api_id, not status, not posted_by_user_id, not parsed_match_date, not posted_at.
 *
 * IT CANNOT POST, AND THAT IS STRUCTURAL RATHER THAN CAREFUL. This file does not import
 * postVeoLinkToMatch, or anything that reaches the chat; the only statement that writes names two
 * columns; and the body is rejected unless it is exactly the flag clear, the same way the sibling
 * PATCH rejects anything but status:"queued". Ryan's standing rule is that no old film may post
 * again, and a route that merely happens not to post today is not the same promise.
 *
 * posted_by_user_id IS DELIBERATELY NOT SET. It would be the obvious place to credit the operator,
 * but recentState reads it as "a person placed this film" and the row would move to "Assigned by
 * hand" — a false statement about who put the film in the chat. The matcher placed it; a person
 * only agreed. The operator is credited in change_log instead, which is where every other write in
 * this codebase records who did it.
 */

import { randomUUID } from "node:crypto";
import { authenticateCrm } from "@/lib/crmAuth";
import { recordWrite, supabaseLogStore } from "@/lib/changeLog";

export const runtime = "nodejs";
export const maxDuration = 20;

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, ctx: Ctx) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { supabase, appUserId } = auth;
  if (!appUserId) return Response.json({ error: "Operator identity required" }, { status: 403 });

  const { id } = await ctx.params;
  if (!id || !UUID_RX.test(id)) return Response.json({ error: "Invalid id" }, { status: 400 });

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  /* THE ONLY BODY THIS ROUTE ACCEPTS. Not "contains flagged:false" — IS exactly that and nothing
   * else, so a caller cannot smuggle a second field past the check and have it interpreted. */
  const keys = Object.keys(body ?? {});
  if (body?.flagged !== false || keys.length !== 1 || keys[0] !== "flagged") {
    return Response.json({ error: "This route only clears the flag on a posted recording." }, { status: 400 });
  }

  const readRow = async (): Promise<Record<string, unknown>> => {
    const { data } = await supabase
      .from("veo_recordings")
      .select("flagged, status, video_url, matched_api_id, posted_by_user_id, posted_at, parsed_match_date, queue_reason")
      .eq("id", id)
      .maybeSingle();
    return (data ?? {}) as Record<string, unknown>;
  };

  const before = await readRow();
  if (!Object.keys(before).length) return Response.json({ error: "Not found" }, { status: 404 });

  let missing = false;
  const { error: writeErr, outcome } = await recordWrite(
    {
      env: "production", source: "Veo · confirm flagged placement",
      actorName: auth.email ?? String(appUserId), actorEmail: auth.email ?? null, saveId: randomUUID(),
      matchId: typeof before.matched_api_id === "number" ? before.matched_api_id : null, matchName: null,
      method: "PATCH", path: `/veo/${id}/flag`,
      body: { flagged: false },
      keys: ["flagged"],
      label: () => "Inferred placement confirmed",
      // THE VERDICT COMES FROM A RE-READ, never from the absence of an error.
      applied: (_b, a) => a.flagged === false,
    },
    {
      now: () => new Date().toISOString(),
      readResource: readRow,
      write: async () => {
        /* TWO COLUMNS. A posted, still-flagged row is the only thing reachable: a queued or
         * dismissed recording cannot be confirmed, and an already-confirmed one is a no-op that
         * reports Not found rather than writing again. */
        const { data, error } = await supabase
          .from("veo_recordings")
          .update({ flagged: false, updated_at: new Date().toISOString() })
          .eq("id", id)
          .eq("status", "posted")
          .eq("flagged", true)
          .select("id")
          .maybeSingle();
        if (error) throw new Error(error.message);
        if (!data) { missing = true; throw new Error("Not found, or not a flagged posted recording"); }
        return { ok: true };
      },
    },
    supabaseLogStore(),
  );

  if (writeErr) {
    console.error("[veo:confirm-flag]", writeErr.message);
    return Response.json({ error: writeErr.message, outcome }, { status: missing ? 404 : 500 });
  }
  console.log(`[veo:confirm-flag] item=${id} by=${appUserId}`);
  return Response.json({ ok: true, outcome }, { status: 200 });
}

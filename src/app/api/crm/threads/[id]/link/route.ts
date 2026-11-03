// POST /api/crm/threads/[id]/link — staff link this thread to an account, or change the account.
//
// Body: { player_id: number }
//
// Auth: authenticateCrm, the same rule as Player Chats (can_access_chats or is_admin). A
// city-confined account can only link to a player in its city. The decision and the change-log
// record live in src/lib/crmThreadLink.ts; this file wires it to Supabase.

import { authenticateCrm } from "@/lib/crmAuth";
import { linkThread, supabaseLinkIO } from "@/lib/crmThreadLink";
import { assertThreadInScope } from "@/lib/crmScope";

export const runtime = "nodejs";

type RouteCtx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: RouteCtx) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { supabase } = auth;
  const { id: threadId } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { player_id?: unknown };
  const playerId = typeof body.player_id === "number" ? body.player_id : Number(body.player_id);
  if (!threadId || !Number.isInteger(playerId) || playerId <= 0) {
    return Response.json({ error: "thread id and a numeric player_id are required" }, { status: 400 });
  }
  const scope = await assertThreadInScope(auth, threadId);
  if (!scope.ok) return Response.json({ error: scope.error }, { status: scope.status });

  const result = await linkThread(
    { threadId, playerId, actor: { appUserId: auth.appUserId, email: auth.email }, confinedCity: auth.confinedCity },
    supabaseLinkIO(supabase, threadId, auth.appUserId),
  ).catch((e: unknown) => {
    console.error("[crm:link] failed", e instanceof Error ? e.message : e);
    return { ok: false as const, status: 500, error: "The link didn't save." };
  });

  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  console.log(`[crm:link] thread=${threadId} action=${result.action} from=${result.from_player_id ?? "-"} to=${result.to_player_id} outcome=${result.outcome}`);
  return Response.json(result, { status: 200 });
}

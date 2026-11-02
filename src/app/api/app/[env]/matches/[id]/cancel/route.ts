// Staff app CANCEL A MATCH (Ryan, 2026-11-01). WRITES NOTHING ITSELF: the desktop cancel route, called
// in process with the caller's token, so EDIT MATCHES, the city boundary on the id, the live name check,
// the one PATCH that texts and credits every player, change_log, the re-read verdict and the reason
// (written only once the cancel landed) all come along unchanged.
//
//   GET   the live preview: { name, count, perPlayerCents, totalCents, alreadyCancelled }
//   POST  { confirmName, reason, note? }   source "Staff app · cancel"
//
// Writes never retry.

import { randomUUID } from "node:crypto";
import { authenticateApp, readRefusal } from "@/lib/appAuth";
import { isEnv } from "@/lib/appLive";
import { callDesktop, passThrough } from "@/lib/appCall";
import { GET as cancelGet, POST as cancelPost } from "@/app/api/matchday/[env]/matches/[id]/cancel/route";
import { reviewMasked } from "@/lib/reviewAccount";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Ctx = { params: Promise<{ env: string; id: string }> };

async function gate(req: Request, ctx: Ctx) {
  const auth = await authenticateApp(req);
  if (!auth.ok) return { res: Response.json({ error: auth.error }, { status: auth.status }) };
  const refused = readRefusal(auth);
  if (refused) return { res: Response.json({ error: refused.error }, { status: refused.status }) };
  const { env, id } = await ctx.params;
  if (!isEnv(env)) return { res: Response.json({ error: `unknown environment ${JSON.stringify(env)}` }, { status: 400 }) };
  if (!/^\d+$/.test(id)) return { res: Response.json({ error: "Match id must be numeric" }, { status: 400 }) };
  return { env, id };
}

async function getRoute(req: Request, ctx: Ctx) {
  const g = await gate(req, ctx);
  if ("res" in g) return g.res;
  return passThrough(await callDesktop(req, cancelGet, `/api/matchday/${g.env}/matches/${g.id}/cancel`, {}, { env: g.env, id: g.id }));
}

export async function POST(req: Request, ctx: Ctx) {
  const g = await gate(req, ctx);
  if ("res" in g) return g.res;
  const body = (await req.json().catch(() => null)) as { confirmName?: string; reason?: string; note?: string } | null;
  return passThrough(await callDesktop(req, cancelPost, `/api/matchday/${g.env}/matches/${g.id}/cancel`, {
    method: "POST", body: { confirmName: body?.confirmName, reason: body?.reason, note: body?.note, source: "Staff app · cancel", saveId: randomUUID() },
  }, { env: g.env, id: g.id }));
}

export const GET = reviewMasked(getRoute);

import "server-only";
// The three moves (POST /api/pushes/:id/send, /pause, /end), one handler. Send also resumes a paused push.
import { offersGate } from "@/lib/offersServer";
import { movePush, pushesErrorText, readPush, verdictResponse, type Move } from "@/lib/pushesServer";

export function moveRoute(move: Move) {
  return async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
    const auth = await offersGate(req);
    if (auth instanceof Response) return auth;
    const id = Number((await ctx.params).id);
    if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Not found" }, { status: 404 });
    let before;
    try { before = (await readPush(id)) ?? undefined; } catch (e) { return Response.json({ error: pushesErrorText(e) }, { status: 502 }); }
    if (!before) return Response.json({ error: "That push no longer exists. Refresh the list." }, { status: 404 });
    return verdictResponse(await movePush(auth, id, move, before));
  };
}

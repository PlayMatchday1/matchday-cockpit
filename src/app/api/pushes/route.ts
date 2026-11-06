// GET /api/pushes: the list page in one answer, for Match Ops: the backend's own list (GET /admin/push-notifications,
// message pushes and every offer with a push, with counts), the cities and fields (GET /admin/offers/page), the first
// page of matches for the tap target, the weekly cap, and whether the pushes backend is there at all.
// POST /api/pushes: a new draft (POST /admin/push-notifications/messages). See src/lib/pushesServer.ts.

import { PUSH_BODY_KEYS as BODY_KEYS } from "@/lib/pushesModel";
import { offersGate, readJson, readFirstMatchPage, readPage, readPushSettings } from "@/lib/offersServer";
import { MESSAGES, fixtureOn, pushesErrorText, pushesWrite, readList, verdictResponse } from "@/lib/pushesServer";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await offersGate(req);
  if (auth instanceof Response) return auth;
  try {
    const page = await readPage();
    const list = await readList();
    let matches: Awaited<ReturnType<typeof readFirstMatchPage>> = { matches: [], complete: false };
    let matchesError: string | null = null;
    try { matches = await readFirstMatchPage(); } catch (e) { matchesError = pushesErrorText(e); }
    let weeklyCap: number | null = null;
    try { weeklyCap = (await readPushSettings()).weeklyCap; } catch (e) { console.error(`[pushes] weekly cap: ${pushesErrorText(e)}`); }
    return Response.json({
      list: list.page, backend: list.backend, backendError: list.error ?? null, fixture: fixtureOn(),
      cities: page.cities, fields: page.fields, matches: matches.matches, matchesComplete: matches.complete, matchesError, weeklyCap,
    });
  } catch (e) {
    return Response.json({ error: pushesErrorText(e) }, { status: 502 });
  }
}

export async function POST(req: Request) {
  const auth = await offersGate(req);
  if (auth instanceof Response) return auth;
  const raw = await readJson(req);
  if (raw instanceof Response) return raw;
  const body = Object.fromEntries(Object.entries(raw).filter(([k]) => BODY_KEYS.has(k)));
  if (typeof body.name !== "string" || !body.name.trim()) return Response.json({ error: "Give it a name." }, { status: 400 });
  return verdictResponse(await pushesWrite({ auth, source: "pushes:create", method: "POST", path: MESSAGES, body, id: null }));
}

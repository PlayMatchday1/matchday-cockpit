// GET /api/pushes: the page in one answer, for Match Ops: the pushes (proposed GET /admin/pushes), the offers whose
// push shows in the same list (real, GET /admin/offers/page, with its cities and fields), the first page of matches
// for the tap target, the weekly cap, and whether the pushes backend is there at all (backend: ready | missing).
// POST /api/pushes: a new draft. See src/lib/pushesServer.ts.

import { PUSH_BODY_KEYS as BODY_KEYS } from "@/lib/pushesModel";
import { offersGate, readJson, readFirstMatchPage, readPage } from "@/lib/offersServer";
import { PUSHES, fixtureOn, pushesErrorText, pushesWrite, readPushes, readWeeklyCap, verdictResponse } from "@/lib/pushesServer";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await offersGate(req);
  if (auth instanceof Response) return auth;
  try {
    const page = await readPage();
    const pushes = await readPushes();
    let matches: Awaited<ReturnType<typeof readFirstMatchPage>> = { matches: [], complete: false };
    let matchesError: string | null = null;
    try { matches = await readFirstMatchPage(); } catch (e) { matchesError = pushesErrorText(e); }
    const weeklyCap = await readWeeklyCap();
    return Response.json({
      pushes: pushes.pushes, backend: pushes.backend, backendError: pushes.error ?? null, fixture: fixtureOn(),
      offers: page.campaigns, cities: page.cities, fields: page.fields, matches: matches.matches, matchesComplete: matches.complete, matchesError, weeklyCap,
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
  return verdictResponse(await pushesWrite({ auth, source: "pushes:create", method: "POST", path: PUSHES, body, id: null, expect: body }));
}

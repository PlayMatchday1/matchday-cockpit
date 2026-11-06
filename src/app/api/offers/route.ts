// GET /api/offers: the campaigns (newest first, each with its results), the cities, the fields (for
// Played at and the photo picker) and one page of upcoming matches for the picker. If the matches can't
// be read the offers still load: pausing or ending one must not depend on the picker.
// POST /api/offers: create a draft. The body is the page's createBody; keys outside BODY_KEYS are
// dropped. The verdict comes from the campaign the backend returns.

import { BODY_KEYS } from "@/lib/offersModel";
import { CAMPAIGNS, errorText, offersGate, offersWrite, readFirstMatchPage, readJson, readPage, readPushVisibility, verdictResponse } from "@/lib/offersServer";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await offersGate(req);
  if (auth instanceof Response) return auth;
  try {
    // One read, then the picker's page. A match an offer names but this list doesn't have is read when that offer is opened.
    const page = await readPage();
    const list = await readFirstMatchPage().then((l) => ({ ...l, error: null as string | null }), (e) => ({ matches: [], complete: false, error: errorText(e) }));
    // pushes: whether to draw the push controls. Off production always; on production the backend's push mode decides,
    // and reading it is a second paced read (GET /api/offers/push-mode), so the page answers without it and the browser asks.
    const pushes = (await readPushVisibility(null)).visible;
    return Response.json({ ...page, matches: list.matches, matchesComplete: list.complete, matchesError: list.error, pushes, pushesAsk: !pushes && page.campaigns.length > 0 ? page.campaigns[0].id : null });
  } catch (e) {
    return Response.json({ error: errorText(e) }, { status: 502 });
  }
}

export async function POST(req: Request) {
  const auth = await offersGate(req);
  if (auth instanceof Response) return auth;
  const raw = await readJson(req);
  if (raw instanceof Response) return raw;
  const body = Object.fromEntries(Object.entries(raw).filter(([k]) => BODY_KEYS.has(k)));
  if (typeof body.name !== "string" || !body.name.trim()) return Response.json({ error: "Give the offer a name." }, { status: 400 });
  const w = await offersWrite({ auth, source: "offers:create", method: "POST", path: CAMPAIGNS, body, id: null, expect: { ...body, status: "DRAFT" } });
  return verdictResponse(w);
}

// GET /api/offers: the campaigns (newest first, each with its results), the cities, the fields (for
// Played at and the photo picker) and one page of upcoming matches for the picker. If the matches can't
// be read the offers still load: pausing or ending one must not depend on the picker.
// POST /api/offers: create a draft. The body is the page's createBody; keys outside BODY_KEYS are
// dropped. The verdict comes from reading the new campaign back by the id the backend returned.

import { BODY_KEYS } from "@/lib/offersModel";
import { CAMPAIGNS, errorText, offersGate, offersWrite, readFirstMatchPage, readJson, readPage, verdictResponse } from "@/lib/offersServer";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await offersGate(req);
  if (auth instanceof Response) return auth;
  try {
    // One read, then the picker's page. A match an offer names but this list doesn't have is read when that offer is opened.
    const page = await readPage();
    const list = await readFirstMatchPage().then((l) => ({ ...l, error: null as string | null }), (e) => ({ matches: [], complete: false, error: errorText(e) }));
    return Response.json({ ...page, matches: list.matches, matchesComplete: list.complete, matchesError: list.error });
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

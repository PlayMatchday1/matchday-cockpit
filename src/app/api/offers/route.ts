// GET /api/offers: the campaigns (newest first, each with its results), the cities, and the upcoming
// matches for the match picker, cut down (src/lib/offersServer.ts matchOpt).
// POST /api/offers: create a draft. The body is the page's createBody; keys outside BODY_KEYS are
// dropped. The verdict comes from reading the new campaign back by the id the backend returned.

import { BODY_KEYS, type City } from "@/lib/offersModel";
import { CAMPAIGNS, OFFERS_ENV, errorText, offersGate, offersWrite, readCampaigns, readJson, readMatch, readUpcomingMatches, verdictResponse } from "@/lib/offersServer";
import { apiGet } from "@/lib/matchdayStageApi";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await offersGate(req);
  if (auth instanceof Response) return auth;
  try {
    const [campaigns, citiesRaw, upcoming] = await Promise.all([
      readCampaigns(),
      apiGet<{ id: number; name: string }[]>(OFFERS_ENV, "/admin/cities"),
      readUpcomingMatches(),
    ]);
    const cities: City[] = citiesRaw.map((c) => ({ id: c.id, name: c.name })).sort((a, b) => a.name.localeCompare(b.name));
    // Matches a campaign is scoped to (or its button opens) that are no longer upcoming, so their labels still show.
    const known = new Set(upcoming.map((m) => m.id));
    const missing = [...new Set(campaigns.flatMap((c) => [...c.matchIds, ...(c.buttonMatchId ? [c.buttonMatchId] : [])]))].filter((id) => !known.has(id));
    const past = (await Promise.all(missing.map(readMatch))).filter((m) => m !== null);
    return Response.json({ campaigns, cities, matches: [...upcoming, ...past] });
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

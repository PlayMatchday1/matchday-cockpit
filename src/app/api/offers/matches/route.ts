// GET /api/offers/matches?cityIds=1,2: upcoming matches in those cities for the picker, used only when
// the page's load didn't hold all of them. Paced, and stops at the first error (readMatchesForCities).

import { errorText, offersGate, readMatchesForCities } from "@/lib/offersServer";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await offersGate(req);
  if (auth instanceof Response) return auth;
  const raw = new URL(req.url).searchParams.get("cityIds") ?? "";
  const cityIds = raw ? raw.split(",").map(Number) : [];
  if (!cityIds.every((x) => Number.isInteger(x) && x > 0)) return Response.json({ error: "cityIds must be whole numbers." }, { status: 400 });
  try { return Response.json(await readMatchesForCities(cityIds)); }
  catch (e) { return Response.json({ error: errorText(e) }, { status: 502 }); }
}

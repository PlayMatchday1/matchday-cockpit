// GET /api/city-directory — MatchDay's own city list (GET /cities + GET /admin/fields, shaped by
// cityDirectory.ts), for client pages that used to read a hard-coded list. Read only. Two
// production GETs per call, the same two /api/fields makes. Gate: Match Ops read.
//
// Returns fieldFormCities: every city less El Paso and New York (EXCLUDED_CITY_ABBRS). Callers that
// need "cities with a field" filter on fieldCount.
import { authenticateMatchOpsRead } from "@/lib/matchOpsAuth";
import { fetchCityDirectory } from "@/lib/cityDirectoryServer";
import { fieldFormCities } from "@/lib/cityDirectory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await authenticateMatchOpsRead(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  try {
    const dir = fieldFormCities(await fetchCityDirectory("production"));
    return Response.json({
      cities: dir.map((c) => ({ id: c.id, abbr: c.abbr, display: c.display, name: c.name, fieldCount: c.fields.length })),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message.slice(0, 200) : "city list read failed" }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}

// GET /api/matchday/{env}/matches/template?fieldId=N — a blank match on a field, for the editor.
//
// READ-ONLY. Nothing is written here; the write is POST …/matches/create, unchanged, which holds the
// EDIT MATCHES gate, the confinement check on the fieldId, the duplicate guard and the audit entry.
//
// THE SHAPE IS THE DETAIL ROUTE'S — { match, fields, managers, managersAllCities } — so MatchEditor
// loads it through the same code it loads a source match through. What a blank match holds, and why,
// is in src/lib/newMatchFromField.ts.
//
// A static segment, so it takes precedence over [id] and "template" is never read as a match id.
import { authenticateMatchOpsRead } from "@/lib/matchOpsAuth";
import { apiGet, type MatchdayEnv } from "@/lib/matchdayStageApi";
import { fieldCityInScope } from "@/lib/fieldScope";
import { CONFINED_CITY_ERROR } from "@/lib/cityConfinement";
import { newMatchTemplate } from "@/lib/newMatchFromField";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const isEnv = (x: string): x is MatchdayEnv => x === "staging" || x === "production";

type ListedField = { id: number; title?: string | null; city?: { id?: number; abbr?: string | null; name?: string | null } | null };

export async function GET(req: Request, ctx: { params: Promise<{ env: string }> }) {
  const auth = await authenticateMatchOpsRead(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { env } = await ctx.params;
  if (!isEnv(env)) return Response.json({ error: `unknown environment ${JSON.stringify(env)}` }, { status: 400 });
  const raw = new URL(req.url).searchParams.get("fieldId") ?? "";
  if (!/^\d+$/.test(raw)) return Response.json({ error: "fieldId must be numeric" }, { status: 400 });
  const fieldId = Number(raw);

  try {
    const fields = await apiGet<ListedField[]>(env, "/admin/fields");
    const all = Array.isArray(fields) ? fields : [];
    const field = all.find((f) => Number(f.id) === fieldId);
    /* THE BOUNDARY, from the session. A confined account sees only its own market's fields, and a
     * field outside it is refused with the same words as one that does not exist. */
    const bound = { confined: auth.confined, confinedCity: auth.confinedCity };
    if (!field || (auth.confined && !fieldCityInScope(bound, field.city))) {
      return Response.json({ error: field ? CONFINED_CITY_ERROR : `Field ${fieldId} is not in MatchDay's field list.` },
        { status: field ? 403 : 404 });
    }
    const visible = auth.confined ? all.filter((f) => fieldCityInScope(bound, f.city)) : all;
    const fieldList = visible.map((f) => ({
      id: Number(f.id), title: (f.title ?? "").trim() || `Field ${f.id}`, city: f.city?.name ?? null,
    }));

    // THE CITY'S MANAGERS, the same two lists and the same endpoint the detail route reads. Only id
    // and name cross to the client.
    const toOptions = (r: unknown) => {
      const arr = Array.isArray(r) ? r : ((r as { data?: unknown[] })?.data ?? []);
      return (arr as Record<string, unknown>[]).map((u) => ({
        id: u.id as number,
        name: [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || `User ${u.id}`,
      }));
    };
    const cityId = field.city?.id;
    const [managers, managersAllCities] = await Promise.all([
      cityId != null
        ? apiGet<unknown>(env, "/city-managers/users", { cityId }).then(toOptions).catch(() => [])
        : Promise.resolve([] as { id: number; name: string }[]),
      apiGet<unknown>(env, "/city-managers/users").then(toOptions).catch(() => []),
    ]);

    const match = newMatchTemplate({
      id: fieldId, title: (field.title ?? "").trim() || `Field ${fieldId}`, cityName: field.city?.name ?? null,
    });
    return Response.json({ match, fields: fieldList, players: [], managers, managersAllCities },
      { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}

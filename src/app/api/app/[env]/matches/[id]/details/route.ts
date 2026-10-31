// Staff app MATCH v2: the detail rows. Ryan, 2026-10-30: "every field the desktop can edit, through a
// new /api/app route that calls the desktop handlers with the caller's token, like adjust."
//
//   GET   the editable values and the option lists (fields, the city's managers, every manager),
//         from the desktop editor's own GET, called in process with the caller's headers.
//   POST  { changes }  the desktop editor's own PUT, in process: its EDITABLE_KEYS allowlist, its
//         date-pair rule (a lone startDate is refused), the EDIT MATCHES grant, the city boundary,
//         recordWrite into change_log with the caller as the actor. Then a LIVE read-back here,
//         field by field, that says where MatchDay disagrees with what was sent.
//
// Nothing about what is editable is decided here. The desktop route is the rule.

import { randomUUID } from "node:crypto";
import { authenticateApp, readRefusal } from "@/lib/appAuth";
import { cityAllowed } from "@/lib/appModel";
import { isEnv } from "@/lib/appLive";
import { apiGet, StageConfigError, StageHostGuardError } from "@/lib/matchdayStageApi";
import { CONFINED_CITY_ERROR } from "@/lib/cityConfinement";
import { GET as desktopMatchGet, PUT as desktopMatchPut } from "@/app/api/matchday/[env]/matches/[id]/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Row = Record<string, unknown>;
const SOURCE = "Staff app · Match details";

async function gate(req: Request, ctx: { params: Promise<{ env: string; id: string }> }) {
  const auth = await authenticateApp(req);
  if (!auth.ok) return { error: Response.json({ error: auth.error }, { status: auth.status }) };
  const refused = readRefusal(auth);
  if (refused) return { error: Response.json({ error: refused.error }, { status: refused.status }) };
  const { env, id } = await ctx.params;
  if (!isEnv(env)) return { error: Response.json({ error: `unknown environment ${JSON.stringify(env)}` }, { status: 400 }) };
  if (!/^\d+$/.test(id)) return { error: Response.json({ error: "match id must be numeric" }, { status: 400 }) };
  const live = await apiGet<Row>(env, `/admin/matches/${id}`);
  const city = ((live.field as Row | undefined)?.city as Row | undefined)?.name;
  if (!cityAllowed(auth, auth.scopeCityName, typeof city === "string" ? city : null)) {
    return { error: Response.json({ error: CONFINED_CITY_ERROR }, { status: 403 }) };
  }
  return { env, id, live };
}

export async function GET(req: Request, ctx: { params: Promise<{ env: string; id: string }> }) {
  try {
    const g = await gate(req, ctx);
    if ("error" in g) return g.error;
    const { env, id } = g;
    const url = new URL(req.url);
    const res = await desktopMatchGet(new Request(`${url.origin}/api/matchday/${env}/matches/${id}`, { headers: { authorization: req.headers.get("authorization") ?? "" } }), { params: Promise.resolve({ env, id }) });
    const j = (await res.json().catch(() => null)) as Row | null;
    if (!res.ok) return Response.json({ error: j?.error ?? `HTTP ${res.status}` }, { status: res.status });
    const m = (j?.match as Row) ?? {};
    const fields = ((j?.fields as Row[]) ?? []).map((f) => ({ id: Number(f.id), title: String(f.title), city: (f.city as string | null) ?? null }));
    // The match's own city first, the rest after, so the sheet opens on the fields that matter.
    fields.sort((a, b) => Number(b.city === m.cityName) - Number(a.city === m.cityName) || a.title.localeCompare(b.title));
    return Response.json({ match: m, fields, managers: j?.managers ?? [], managersAllCities: j?.managersAllCities ?? [] });
  } catch (e) { return fail(e); }
}

export async function POST(req: Request, ctx: { params: Promise<{ env: string; id: string }> }) {
  try {
    const g = await gate(req, ctx);
    if ("error" in g) return g.error;
    const { env, id, live: before } = g;
    const body = (await req.json().catch(() => null)) as { changes?: Row } | null;
    const changes = body?.changes;
    if (!changes || typeof changes !== "object" || Array.isArray(changes) || Object.keys(changes).length === 0) {
      return Response.json({ error: "changes required" }, { status: 400 });
    }
    /* THE DIFF ONLY, as the desktop panel sends it. A key already holding the asked value is dropped
     * before the write, and a request with nothing left is refused, so an unchanged Save never
     * reaches MatchDay or change_log. */
    const same = (a: unknown, b: unknown) => (a == null && b == null) || String(a) === String(b)
      || (typeof a === "string" && typeof b === "string" && /^\d{4}-\d\d-\d\dT/.test(a) && a.slice(0, 16) === b.slice(0, 16));
    const diff = Object.fromEntries(Object.entries(changes).filter(([k, v]) => k === "teamNumbers" || !same(before[k], v)));
    // The desktop's date pair rule still applies to what is sent: a changed start carries its end.
    if ("startDate" in diff && !("endDate" in diff) && "endDate" in changes) diff.endDate = changes.endDate;
    if (Object.keys(diff).length === 0) return Response.json({ error: "Nothing to change: MatchDay already holds these values." }, { status: 400 });

    const saveId = randomUUID();
    const url = new URL(req.url);
    const res = await desktopMatchPut(new Request(`${url.origin}/api/matchday/${env}/matches/${id}`, {
      method: "PUT", headers: { authorization: req.headers.get("authorization") ?? "", "content-type": "application/json" },
      body: JSON.stringify({ changes: diff, source: SOURCE, saveId }),
    }), { params: Promise.resolve({ env, id }) });
    const j = (await res.json().catch(() => null)) as Row | null;
    // A refusal is not a save: the desktop's own status and sentence, as-is.
    if (!res.ok) return Response.json({ error: j?.error ?? `HTTP ${res.status}` }, { status: res.status });

    const after = await apiGet<Row>(env, `/admin/matches/${id}`);
    const disagreements = Object.entries(changes)
      .filter(([k]) => k !== "teamNumbers")
      .filter(([k, v]) => !same(after[k], v))
      .map(([k, v]) => `${k} reads back as ${JSON.stringify(after[k] ?? null)}, not ${JSON.stringify(v)}.`);
    return Response.json({
      saveId, outcome: String(j?.outcome ?? "unknown").toLowerCase(), landed: String(j?.outcome ?? "").toLowerCase() === "landed",
      sent: diff,
      before: Object.fromEntries(Object.keys(changes).map((k) => [k, before[k] ?? null])),
      readBack: Object.fromEntries(Object.keys(changes).map((k) => [k, after[k] ?? null])),
      readAt: new Date().toISOString(), disagreements,
    });
  } catch (e) { return fail(e); }
}

function fail(e: unknown) {
  if (e instanceof StageHostGuardError || e instanceof StageConfigError) return Response.json({ error: e.message }, { status: 500 });
  const msg = e instanceof Error ? e.message : String(e);
  if (/HTTP 404/.test(msg)) return Response.json({ error: "No match with that id." }, { status: 404 });
  return Response.json({ error: msg }, { status: 502 });
}

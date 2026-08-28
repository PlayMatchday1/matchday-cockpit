/* FIELDS — the read and the writes behind /match-ops/fields.
 *
 * Clubhouse had no field admin before this. Everything here was measured against the API on
 * 2026-08-28 (staging for writes, production for reads); see docs/matchday-api-facts.md.
 *
 *   GET    /api/fields              the list, plus fin_venue_fields links and per-field match counts
 *   POST   /api/fields              -> POST /admin/fields          create
 *   PUT    /api/fields?id=          -> PUT  /admin/fields/{id}      update, diff-as-body
 *   DELETE /api/fields?id=          -> DELETE /admin/fields/{id}    BOLTED, see DELETE_ENABLED
 *
 * WHO. authenticateMatchOpsRead for the read; the writes additionally require EDIT MATCHES via
 * apiWrite's own guard, which is the unbypassable chokepoint. A field record decides what a match
 * says it was played on, so it sits behind the same right as the match itself.
 *
 * THERE IS NO SINGLE-FIELD GET. /admin/fields/{id} is a 404 — measured. Every read-back therefore
 * re-fetches the LIST and finds the id in it. That is still a read-back and it is still required:
 * the create returns a body, and a returned body is the server describing its intent, not the
 * stored row.
 */

import { authenticateMatchOpsRead } from "@/lib/matchOpsAuth";
import { makeServerClient } from "@/lib/supabaseServer";
import { randomUUID } from "node:crypto";
import { apiGet, apiWrite } from "@/lib/matchdayStageApi";
import { recordWrite, supabaseLogStore } from "@/lib/changeLog";
import {
  createBody, updateBody, CREATE_KEYS, UPDATE_KEYS, deleteBlock, type Link,
} from "@/lib/fieldsModel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/* THE DELETE BOLT. The write is built, guarded and proven on staging, and it does NOT reach
 * production from this page in this pass — by ruling. Flipping this to true is the whole of
 * enabling it; there is no second switch and no migration. What it would take is in the report:
 * a decision that soft-deleting a field with zero matches is safe, and an owner for the orphaned
 * phone-number rows the API leaves behind. */
const DELETE_ENABLED = false;

type ApiField = {
  id: number; title: string; abbr: string | null; address: string | null;
  zipcode: number | null; description: string | null; parkingNote: string | null;
  lat: number | null; lng: number | null; cityId: number | null;
  recommendedPlayerCount: number | null; orderPosition: number | null;
  cover: string | null; images?: { id: number; url: string }[] | null;
  city?: { id?: number; name?: string | null } | null;
};

const listFields = (env: "production" | "staging") => apiGet<ApiField[]>(env, "/admin/fields");

/** READ-BACK. No single-field GET exists, so this is the only honest way to see a stored row. */
async function readBack(env: "production" | "staging", id: number): Promise<ApiField | null> {
  const rows = await listFields(env).catch(() => [] as ApiField[]);
  return rows.find((f) => Number(f.id) === Number(id)) ?? null;
}

const ENV = "production" as const;

export async function GET(req: Request) {
  const auth = await authenticateMatchOpsRead(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  try {
    const sb = makeServerClient();
    const [fields, linkRes, cities] = await Promise.all([
      listFields(ENV),
      sb.from("fin_venue_fields").select("mdapi_field_id,fin_venue_id"),
      apiGet<{ id: number; name: string }[]>(ENV, "/cities").catch(() => [] as { id: number; name: string }[]),
    ]);
    if (linkRes.error) throw new Error(`fin_venue_fields read failed: ${linkRes.error.message}`);
    const links = (linkRes.data ?? []) as Link[];

    /* PER-FIELD MATCH COUNTS drive the Delete block, so they must be COMPLETE — every match ever,
     * not a window and not a page. An undercount here is a field that looks deletable and is not.
     * Paged, ordered, and the error is raised rather than folded into a zero. */
    const counts = new Map<number, number>();
    for (let off = 0; ; off += 1000) {
      const { data, error } = await sb.from("mdapi_matches")
        .select("field_id").not("field_id", "is", null).order("api_id").range(off, off + 999);
      if (error) throw new Error(`mdapi_matches read failed: ${error.message}`);
      for (const m of data ?? []) {
        const f = Number((m as { field_id: number }).field_id);
        counts.set(f, (counts.get(f) ?? 0) + 1);
      }
      if (!data || data.length < 1000) break;
    }

    /* FIELDS WITH A MATCH THIS CALENDAR MONTH — the second half of the banner. Same window and
     * same bounds as Home's ACTIVE FIELDS tile, so the two pages cannot disagree about what
     * "running matches this month" means. */
    const now = new Date();
    const cp = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(now);
    const part = (t: string) => cp.find((x) => x.type === t)!.value;
    const monthStart = `${part("year")}-${part("month")}-01T00:00:00`;
    /* BOUNDED AT TODAY, exactly as Home's ACTIVE FIELDS tile is. Without the upper bound this
     * counted matches SCHEDULED later in the month and reported 2 where Home reports 1 — two
     * pages disagreeing about "running matches this month" while this file claimed they agreed.
     * start_date is wall clock wearing a Z, so both bounds are plain strings and the comparison is
     * lexicographic. */
    const todayEnd = `${part("year")}-${part("month")}-${part("day")}T23:59:59.999`;
    const active = new Set<number>();
    for (let off = 0; ; off += 1000) {
      const { data, error } = await sb.from("mdapi_matches")
        .select("field_id").eq("is_cancelled", false).is("deleted_at", null)
        .gte("start_date", monthStart).lte("start_date", todayEnd).order("api_id").range(off, off + 999);
      if (error) throw new Error(`mdapi_matches month read failed: ${error.message}`);
      for (const r of data ?? []) {
        const f = (r as { field_id: number | null }).field_id;
        if (f != null) active.add(Number(f));
      }
      if (!data || data.length < 1000) break;
    }

    return Response.json({
      fields: fields.map((f) => ({
        id: Number(f.id), title: f.title ?? "", abbr: f.abbr ?? "", address: f.address ?? "",
        zipcode: f.zipcode ?? null, description: f.description ?? "", parkingNote: f.parkingNote ?? "",
        lat: f.lat ?? null, lng: f.lng ?? null, cityId: f.cityId ?? null,
        cityName: f.city?.name ?? null,
        recommendedPlayerCount: f.recommendedPlayerCount ?? null,
        orderPosition: f.orderPosition ?? null,
        cover: f.cover ?? null, images: (f.images ?? []).map((i) => ({ id: i.id, url: i.url })),
        matchCount: counts.get(Number(f.id)) ?? 0,
      })),
      links: links.map((l) => ({ fieldId: Number(l.mdapi_field_id), venueId: l.fin_venue_id })),
      activeFieldIds: [...active],
      cities: cities.map((c) => ({ id: Number(c.id), name: c.name })),
      deleteEnabled: DELETE_ENABLED,
    });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message.slice(0, 200) : "read failed" }, { status: 500 });
  }
}

/* ── CREATE ────────────────────────────────────────────────────────────────────────────────────
 * The server requires title + cityId and nothing else; the FORM requires more, and that check
 * lives on the client where the operator can see what is missing. The route re-checks the
 * server's two, because a client is a convenience and this is a write.
 *
 * THE DTO IS A WHITELIST. An extra key is a 400 naming the key — not an ignored field — so the
 * body is built from CREATE_KEYS and nothing else can leak into it. */
export async function POST(req: Request) {
  const auth = await authenticateMatchOpsRead(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const draft = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!draft) return Response.json({ error: "body required" }, { status: 400 });
  const body = createBody(draft);
  if (!body.title) return Response.json({ error: "title is required" }, { status: 400 });
  if (body.cityId == null || !Number.isInteger(body.cityId)) {
    return Response.json({ error: "cityId must be an integer" }, { status: 400 });
  }

  const saveId = randomUUID();
  let newId: number | null = null;

  /* THE VERDICT IS A READ-BACK, NOT THE 2xx. The create response carries an id; we take the id
   * from it and then go and look for that row in the LIST, because the list is what every other
   * surface reads. `applied` asks whether the row is there with the title we sent. */
  const { outcome, error, logged } = await recordWrite(
    {
      env: ENV, source: "Fields · create",
      actorName: auth.email, actorEmail: auth.email, saveId,
      matchId: null, matchName: null,
      method: "POST", path: "/admin/fields",
      body, keys: [...CREATE_KEYS], label: (k) => k,
      applied: (_before, after) => after.found === true,
    },
    {
      readResource: async () => (newId == null ? { found: false } : { found: (await readBack(ENV, newId)) != null }),
      write: async () => {
        const r = await apiWrite<{ id: number }>(ENV, "POST", "/admin/fields", body, {
          canEditMatches: true, email: auth.email,
        });
        newId = Number(r?.id) || null;
        return r;
      },
      now: () => new Date().toISOString(),
    },
    supabaseLogStore(),
  );

  const row = newId == null ? null : await readBack(ENV, newId);
  const verdict = row != null ? "LANDED" : outcome === "unknown" ? "UNKNOWN" : "FAILED";
  return Response.json({
    verdict, id: newId, row, logged,
    error: error ? error.message.slice(0, 200) : null,
  }, { status: row != null ? 200 : 502 });
}

/* ── UPDATE ────────────────────────────────────────────────────────────────────────────────────
 * PUT, not PATCH — PATCH is a 404 on this resource. PUT has PATCH semantics: a single-key body
 * leaves every other column alone, proven on staging. So the diff IS the body, and an empty diff
 * is not a write at all. */
export async function PUT(req: Request) {
  const auth = await authenticateMatchOpsRead(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "id required" }, { status: 400 });
  const payload = (await req.json().catch(() => null)) as { orig?: Record<string, unknown>; draft?: Record<string, unknown> } | null;
  if (!payload?.orig || !payload?.draft) return Response.json({ error: "orig and draft required" }, { status: 400 });

  const body = updateBody(payload.orig, payload.draft);
  const keys = Object.keys(body);
  // NOT APPLIED, said plainly. An empty diff means nothing changed; sending it would be a write
  // with no content and a 2xx that means nothing.
  if (keys.length === 0) return Response.json({ verdict: "NOT APPLIED", reason: "nothing changed", id }, { status: 200 });

  const saveId = randomUUID();
  const { outcome, error, logged } = await recordWrite(
    {
      env: ENV, source: "Fields · update",
      actorName: auth.email, actorEmail: auth.email, saveId,
      matchId: null, matchName: null,
      method: "PUT", path: `/admin/fields/${id}`,
      body, keys: [...UPDATE_KEYS], label: (k) => k,
      // EVERY KEY WE SENT MUST BE WHAT THE LIST NOW SAYS. Not "did it 2xx".
      applied: (_before, after) => keys.every((k) => String((after as Record<string, unknown>)[k] ?? "") === String(body[k] ?? "")),
    },
    {
      readResource: async () => (await readBack(ENV, id)) as unknown as Record<string, unknown> ?? {},
      write: () => apiWrite(ENV, "PUT", `/admin/fields/${id}`, body, { canEditMatches: true, email: auth.email }),
      now: () => new Date().toISOString(),
    },
    supabaseLogStore(),
  );

  const row = await readBack(ENV, id);
  const landed = row != null && keys.every((k) => String((row as unknown as Record<string, unknown>)[k] ?? "") === String(body[k] ?? ""));
  const verdict = landed ? "LANDED" : row == null ? "UNKNOWN" : outcome === "unknown" ? "UNKNOWN" : "FAILED";
  return Response.json({ verdict, id, sent: body, row, logged, error: error ? error.message.slice(0, 200) : null },
    { status: landed ? 200 : 502 });
}

/* ── DELETE ────────────────────────────────────────────────────────────────────────────────────
 * THREE GUARDS, and the API supplies none of them.
 *   1. DELETE_ENABLED — bolted off for production in this pass, by ruling.
 *   2. MATCH COUNT — refused if the field has ever hosted a match. The API does NOT check: a
 *      field with a live match on it deletes with a 2xx and leaves the match pointing at a row
 *      nothing will render. Proven on staging.
 *   3. TYPED NAME — the client requires the exact field name before it will call this, and the
 *      route requires it too, because a client-side confirmation is a courtesy. */
export async function DELETE(req: Request) {
  const auth = await authenticateMatchOpsRead(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const url = new URL(req.url);
  const id = Number(url.searchParams.get("id"));
  const confirm = (url.searchParams.get("confirm") ?? "").trim();
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "id required" }, { status: 400 });

  if (!DELETE_ENABLED) {
    return Response.json({
      error: "Deleting fields is not enabled from Clubhouse. The write is built and proven on staging; " +
        "it is bolted off for production in this pass.",
    }, { status: 403 });
  }

  try {
    const sb = makeServerClient();
    const rows = await listFields(ENV);
    const field = rows.find((f) => Number(f.id) === id);
    if (!field) return Response.json({ error: `field ${id} is not in /admin/fields` }, { status: 404 });
    if (confirm !== String(field.title ?? "").trim()) {
      return Response.json({ error: "confirm must be the field's exact name" }, { status: 400 });
    }

    const { count, error: cErr } = await sb.from("mdapi_matches")
      .select("api_id", { count: "exact", head: true }).eq("field_id", id);
    if (cErr) throw new Error(`match count failed: ${cErr.message}`);
    const block = deleteBlock(count ?? 0);
    if (!block.ok) return Response.json({ error: block.reason }, { status: 409 });

    const saveId = randomUUID();
    const { outcome, error } = await recordWrite(
      {
        env: ENV, source: "Fields · delete",
        actorName: auth.email, actorEmail: auth.email, saveId,
        matchId: null, matchName: null,
        method: "DELETE", path: `/admin/fields/${id}`,
        body: { id }, keys: ["id"], label: (k) => k,
        // GONE FROM THE LIST is the verdict. The delete is SOFT — the row survives and still
        // accepts a PUT — so "absent from /admin/fields" is the only observable we have.
        applied: (_before, after) => after.present === false,
      },
      {
        readResource: async () => ({ present: (await readBack(ENV, id)) != null }),
        write: () => apiWrite(ENV, "DELETE", `/admin/fields/${id}`, undefined, { canEditMatches: true, email: auth.email }),
        now: () => new Date().toISOString(),
      },
      supabaseLogStore(),
    );
    const gone = (await readBack(ENV, id)) == null;
    return Response.json({
      verdict: gone ? "LANDED" : outcome === "unknown" ? "UNKNOWN" : "FAILED",
      id, error: error ? error.message.slice(0, 200) : null,
    }, { status: gone ? 200 : 502 });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message.slice(0, 200) : "delete failed" }, { status: 500 });
  }
}

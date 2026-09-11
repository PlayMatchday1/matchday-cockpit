// POST  /api/venues  { venue, fieldId }  — create a fin_venues row and link it to one mdapi field.
// PATCH /api/venues  { id, patch }       — edit a venue's own columns.
//
// WHY THIS EXISTS: Ryan, "I dont think you should have to go to finance page to add field, you
// should be able to put field cost etc whatever you need for mapping here". The Fields drawer is
// the second way in. Field Costs keeps its own path and is still where a venue covering several
// fields is edited.
//
// ── THE PERMISSION BOUNDARY, AND IT IS THE POINT OF HAVING A ROUTE AT ALL ─────────────────────
// Fields is PagePermissionGuard page="matchops". Field Costs is finance. Moving venue editing into
// the Fields drawer would otherwise let every matchops account write venue rates — including a
// confined city manager — which is a privilege escalation, not a convenience.
//
// FieldCostsView writes fin_venues DIRECTLY from the browser through the supabase client, so the
// only thing standing behind that page today is RLS. A disabled input in a drawer is a courtesy and
// nothing more, so this route exists to make the refusal real:
//
//     authenticateCapability(req, "finance")
//
// checks can_access_finance on app_users, and capabilities.can() returns false for a confined
// account BEFORE the is_admin term — so a city manager carrying is_admin is still refused. It also
// runs assertConfinedRoute over this path, which is not on the allowlist. That is one call covering
// both refusals, and it is server-side: a request made directly with a matchops token is refused
// with no UI involved.
//
// ── ONE FIELD, ONE VENUE ──────────────────────────────────────────────────────────────────────
// fin_venue_fields is mdapi_field_id bigint NOT NULL UNIQUE (0041). A field already linked cannot
// be linked to a second venue. The refusal NAMES the venue that holds it rather than returning a
// 23505, because "which venue has it" is the only useful thing to say.
//
// ── THREE WRITES, AND ANY OF THEM CAN FAIL ON ITS OWN ─────────────────────────────────────────
// handleSubmitAddVenue in FieldCostsView is the precedent: insert the venue, link best-effort, and
// surface a PARTIAL SUCCESS rather than a lie. Here the field record itself is a third write and it
// goes to the MatchDay API from the client, so this route owns two of the three and reports its own
// two honestly. It never returns LANDED for a half-done job.
import { authenticateCapability } from "@/lib/capabilityAuth";
import { authenticateMatchOpsRead } from "@/lib/matchOpsAuth";
import { apiGet } from "@/lib/matchdayStageApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* THE COLUMNS THIS ROUTE WILL WRITE, and nothing else. An allowlist rather than a spread of the
 * request body: fin_venues carries columns that change how cost reconciliation aggregates, and a
 * field-setup drawer has no business setting them.
 *
 * DELIBERATELY ABSENT — billing_cadence and bills_per_reservation. Both feed financeCosts,
 * fieldEconomics and opexSources: cadence drives how a monthly_flat venue is amortised across
 * matches, and bills_per_reservation decides whether a multi-match reservation bills once or per
 * match. Neither is something you know while setting up a pitch, and a wrong value is a wrong
 * number in the P&L rather than a wrong label on a screen. They keep their column defaults
 * ('monthly' and false) on create and are edited on Field Costs.
 *
 * charge_on_cancel IS here: it is a per-venue yes/no the person setting the field up does know,
 * and it is in the approved mock. */
const VENUE_FIELDS = [
  "venue_name", "city", "billing_type", "per_match_rate", "hourly_rate", "cost_per_match",
  "charge_on_cancel",
  // The "on the day" half — same row, different question. 0074 added these.
  "min_players", "max_players", "contact_name", "contact_number", "schedule_url",
] as const;

const pick = (src: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const k of VENUE_FIELDS) if (k in src && src[k] !== undefined) out[k] = src[k];
  return out;
};

/* GET IS MATCHOPS, THE WRITES ARE FINANCE — the split Ryan approved, and it is deliberate rather
 * than an oversight. A city manager seeing that a field has NO cost mapping is useful; a city
 * manager changing a rate is not. So the section renders for matchops with its values and its
 * refusal, and every write above is refused without can_access_finance. */
export async function GET(req: Request) {
  const auth = await authenticateMatchOpsRead(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const fieldId = Number(new URL(req.url).searchParams.get("fieldId"));

  const { data: venues, error } = await auth.supabase
    .from("fin_venues")
    .select("id, venue_name, city, billing_type, per_match_rate, hourly_rate, cost_per_match, charge_on_cancel, min_players, max_players, contact_name, contact_number, schedule_url")
    .eq("is_active", true).order("venue_name");
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const { data: links } = await auth.supabase.from("fin_venue_fields").select("fin_venue_id, mdapi_field_id, field_title_at_link");
  const all = links ?? [];

  let current: { venueId: number; siblings: { fieldId: number; title: string | null }[] } | null = null;
  if (Number.isInteger(fieldId) && fieldId > 0) {
    const mine = all.find((l) => Number(l.mdapi_field_id) === fieldId);
    if (mine) {
      /* THE SIBLINGS ARE THE WHOLE POINT. fin_venue_fields is many-to-one (0041's own header says
       * so), so a venue can collect several pitches — Round Rock has three, Soccer Central four.
       * The drawer names them WITH THEIR IDS before showing values the operator cannot change,
       * because "this moves three other pitches" is not something to discover afterwards. */
      current = {
        venueId: Number(mine.fin_venue_id),
        siblings: all.filter((l) => Number(l.fin_venue_id) === Number(mine.fin_venue_id) && Number(l.mdapi_field_id) !== fieldId)
          .map((l) => ({ fieldId: Number(l.mdapi_field_id), title: l.field_title_at_link ?? null })),
      };
    }
  }
  // Field counts per venue, so the picker can say what choosing one would join.
  const counts: Record<number, number> = {};
  for (const l of all) counts[Number(l.fin_venue_id)] = (counts[Number(l.fin_venue_id)] ?? 0) + 1;

  /* NO canEdit IN THE PAYLOAD. The client computes it from canAccess(appUser, "finance") to
   * disable the control; the REAL gate is POST/PATCH above refusing without the capability. Two
   * sources of truth for a permission is how one of them drifts. */
  return Response.json({ venues: venues ?? [], current, counts },
    { status: 200, headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  const auth = await authenticateCapability(req, "finance");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const body = (await req.json().catch(() => ({}))) as { venue?: Record<string, unknown>; fieldId?: unknown };
  const fieldId = Number(body.fieldId);
  const venue = pick(body.venue ?? {});
  if (!Number.isInteger(fieldId) || fieldId <= 0) return Response.json({ error: "fieldId required" }, { status: 400 });
  if (!venue.venue_name || !venue.city) return Response.json({ error: "venue_name and city are required" }, { status: 400 });

  /* THE FIELD MUST EXIST, AND THIS GUARD EXISTS BECAUSE I BROKE IT. Verifying the permission
   * boundary I posted fieldId 999999 with an admin token: the venue was created and LINKED to a
   * field that does not exist — manufacturing exactly the orphaned fin_venue_fields row this
   * estate already carries seven of. Both rows were deleted; the hole was real either way, because
   * nothing here checked. /admin/fields is the authoritative list, the same one /api/fields reads.
   * A field we cannot confirm is a field we do not link. */
  const known = await apiGet<{ id: number }[]>("production", "/admin/fields").catch(() => null);
  if (known == null) return Response.json({ error: "Could not read the field list to verify the field — nothing was written." }, { status: 502 });
  if (!known.some((f) => Number(f.id) === fieldId)) {
    return Response.json({ error: `Field ${fieldId} is not in /admin/fields. Nothing was written.` }, { status: 404 });
  }

  // REFUSE BEFORE WRITING ANYTHING. A field already linked would fail the UNIQUE on the link
  // insert AFTER the venue row existed, leaving an orphan venue behind.
  const { data: link } = await auth.supabase
    .from("fin_venue_fields").select("fin_venue_id").eq("mdapi_field_id", fieldId).maybeSingle();
  const held: number | null = link?.fin_venue_id ?? null;
  if (held != null) {
    const { data: v } = await auth.supabase.from("fin_venues").select("venue_name, city").eq("id", held).maybeSingle();
    return Response.json({
      error: `Field ${fieldId} is already mapped to ${v?.venue_name ?? `venue ${held}`}${v?.city ? ` (${v.city})` : ""}. `
        + "One field maps to exactly one venue — unmap it on Field Costs first.",
      heldBy: held,
    }, { status: 409 });
  }

  const { data: inserted, error } = await auth.supabase
    .from("fin_venues").insert({ ...venue, is_active: true }).select("id, venue_name, city").single();
  if (error) {
    if (error.code === "23505" || /duplicate key/i.test(error.message ?? "")) {
      return Response.json({
        error: `A venue named "${venue.venue_name}" already exists in ${venue.city}. `
          + "Use the existing one instead of creating a second.",
      }, { status: 409 });
    }
    return Response.json({ error: error.message }, { status: 500 });
  }

  /* THE LINK IS BEST-EFFORT AND ITS FAILURE IS REPORTED, NOT SWALLOWED — the shape
   * handleSubmitAddVenue already uses. The venue row exists either way and can be linked later;
   * what must not happen is reporting success for a venue nothing points at. */
  const { error: linkErr } = await auth.supabase.from("fin_venue_fields").insert({
    fin_venue_id: inserted.id, mdapi_field_id: fieldId,
    field_title_at_link: String((body.venue ?? {}).field_title_at_link ?? "") || null,
  });

  return Response.json({
    ok: !linkErr,
    partial: !!linkErr,
    venue: inserted,
    linked: !linkErr,
    // NAMES THE ONE THING THAT DID NOT HAPPEN. Never LANDED for a half-done job.
    note: linkErr
      ? `The venue "${inserted.venue_name}" was created, but linking it to field ${fieldId} failed `
        + `(${linkErr.message}). The venue exists — link it on Field Costs.`
      : null,
  }, { status: 200 });
}

export async function PATCH(req: Request) {
  const auth = await authenticateCapability(req, "finance");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const body = (await req.json().catch(() => ({}))) as { id?: unknown; patch?: Record<string, unknown> };
  const id = Number(body.id);
  const patch = pick(body.patch ?? {});
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "id required" }, { status: 400 });
  if (Object.keys(patch).length === 0) return Response.json({ error: "nothing to change" }, { status: 400 });

  /* A SHARED VENUE IS EDITABLE FROM A FIELD'S DRAWER — corrected 2026-09-10, Ryan overruling his
   * own brief: "Make shared venue values editable from the Fields drawer, not read-only."
   *
   * THIS USED TO 409 when fin_venue_fields held more than one row for the venue, on the reasoning
   * that changing a rate from one pitch would silently move the others. The silence was the
   * problem, not the write. The drawer now NAMES the other fields before the save and asks once —
   * "Change the rate for 3 fields?" with them listed — so the operator is told what they are about
   * to move and says yes to that specific set. A refusal here would make that confirmation a lie.
   *
   * WHAT DID NOT CHANGE: the finance capability above, and the confined refusal inside it. Those
   * are the boundary; this was a workflow opinion. */
  const { data, error } = await auth.supabase
    .from("fin_venues").update(patch).eq("id", id).select("id, venue_name, city").single();
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ ok: true, venue: data }, { status: 200 });
}

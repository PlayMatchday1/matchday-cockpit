// City manager — GAMEDAY OPS, READ ONLY (Phase 29b).
//
// THE THIRD AND LAST PAGE OF THE TIER. It answers one question — "is tonight covered, and is
// anything short?" — and it answers it for ONE city.
//
// READ ONLY, DELIBERATELY. No match panel, no roster, no cancel preview. The Match Ops board
// carries all three, and each is something this tier must not reach: a roster read is player
// names and phone numbers for every match in the city, and the cancel preview is one confirm
// from crediting and texting every signed-up player. The ONE write a city manager gets is the
// manager assignment, and it stays on /city/manager-pay where it is scoped, logged and read back.
// Clicking a match here links to that row rather than opening anything.
//
// SCOPE COMES FROM THE SESSION, NEVER THE REQUEST. city_identifier is read fresh from the
// caller's app_users row on every call (authenticateCityManager → cityManagerGate, no JWT claim,
// no cache). A caller naming another city with ?city= is REFUSED with a 403 that names their
// scope — not silently corrected, which would look like it worked and show them the wrong city,
// and not a fallback to "all", which is the leak this phase exists to close.
//
// EVERYTHING DERIVED IS COMPUTED AFTER SCOPING. The counts, the short list and the totals are all
// built from the already-scoped rows. A count computed before scoping leaks the SHAPE of data the
// caller cannot see — "you have 40 matches tonight" when four are theirs is still a disclosure.
import { authenticateCityManager } from "@/lib/cityManagerAuth";
import { cityNameFor } from "@/lib/cityScope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Row = Record<string, unknown>;

export async function GET(req: Request) {
  const auth = await authenticateCityManager(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const url = new URL(req.url);
  const asked = url.searchParams.get("city");
  // REFUSED, not corrected. Naming another city is an attempt to read outside the scope, and the
  // honest answer says what the scope is rather than quietly serving something else.
  if (asked != null && asked !== "" && asked !== auth.cityIdentifier) {
    return Response.json({
      error: `You are scoped to ${auth.cityIdentifier}. This account cannot read ${JSON.stringify(asked)}.`,
      scope: auth.cityIdentifier,
    }, { status: 403 });
  }

  const date = (url.searchParams.get("date") || "").trim() || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return Response.json({ error: "date must be YYYY-MM-DD" }, { status: 400 });

  // THE SCOPE IS PUSHED INTO THE QUERY (.eq on city_identifier), never applied after fetching.
  // Filtering in the client — or even in this process — means the unscoped rows existed here.
  const { data, error } = await auth.supabase
    .from("mdapi_matches")
    .select("api_id, name, field_title, start_date, start_date_utc, is_cancelled, manager_id, manager_email, manager_first_name, manager_last_name, second_manager_id, max_player_count, min_player_count, player_count, city_identifier")
    .eq("city_identifier", auth.cityIdentifier)
    .is("deleted_at", null)
    .gte("start_date", `${date}T00:00:00`)
    .lte("start_date", `${date}T23:59:59`)
    .order("start_date_utc", { ascending: true });

  if (error) return Response.json({ error: error.message }, { status: 500 });

  const rows = (data ?? []) as Row[];
  const matches = rows.map((m) => {
    const cap = Number(m.max_player_count ?? 0) || 0;
    const min = Number(m.min_player_count ?? 0) || 0;
    const signed = Number(m.player_count ?? 0) || 0;
    const cancelled = m.is_cancelled === true;
    const managerName = [m.manager_first_name, m.manager_last_name].filter(Boolean).join(" ").trim();
    return {
      matchId: Number(m.api_id),
      name: (m.name as string | null) ?? null,
      field: (m.field_title as string | null) ?? null,
      // start_date is LOCAL WALL CLOCK wearing a Z (the match model, the opposite of promo dates)
      // — handed over verbatim for the label; start_date_utc is the true instant used for order.
      startDate: (m.start_date as string | null) ?? null,
      startDateUtc: (m.start_date_utc as string | null) ?? null,
      cancelled,
      manager: managerName || null,
      managerId: m.manager_id == null ? null : Number(m.manager_id),
      coManaged: m.second_manager_id != null,
      signed, cap, min,
      // "short" is the operationally-safe reading used everywhere else: REAL signups vs the
      // minimum. A cancelled match is not short, it is over.
      short: !cancelled && min > 0 && signed < min,
    };
  });

  // DERIVED AFTER SCOPING — every number below is computed from `matches`, which is already
  // one city's rows and nothing else.
  const summary = {
    total: matches.length,
    cancelled: matches.filter((m) => m.cancelled).length,
    short: matches.filter((m) => m.short).length,
    unassigned: matches.filter((m) => !m.cancelled && m.managerId == null).length,
  };

  return Response.json({
    ok: true,
    scope: auth.cityIdentifier,
    cityName: cityNameFor(auth.cityIdentifier) ?? auth.cityIdentifier,
    date,
    matches,
    summary,
    readOnly: true,
  });
}

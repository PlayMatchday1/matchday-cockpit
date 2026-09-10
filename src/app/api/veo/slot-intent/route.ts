// GET  /api/veo/slot-intent?city=&field=&weekday=&hhmm= — is this slot on a recurring pattern?
// POST /api/veo/slot-intent { city, field, weekday, hhmm, enabled } — set or clear one.
//
// THE PATTERN, NOT THE MATCH. veo_intent is per match and is the OVERRIDE; this table is the
// recurring rule underneath it. Resolution lives in ONE place, veoSchedule.resolveIntentFor, and
// both readers call it — see the note there.
//
// ── enabled:false CLEARS THE ROW, IT DOES NOT STORE A FALSE ───────────────────────────────────
// A stored `false` and a missing row would mean the same thing to the resolver — "the pattern does
// not turn this on" — and two representations of one state is how a resolver acquires a bug. The
// pattern is present or it is not. Turning a match OFF against a live pattern is a per-match
// override and belongs in veo_intent, which is what the chip on the card already writes.
//
// ── STOPPING A PATTERN LEAVES THE OVERRIDES STANDING ──────────────────────────────────────────
// Ryan's call, and it is the safer one: the matches somebody marked by hand stay marked. The panel
// says so before you press it, with the count.
//
// ── THIS ROUTE WRITES NO MATCH NAMES ──────────────────────────────────────────────────────────
// Setting a pattern changes what Clubhouse INTENDS. The camera emoji in the MatchDay name is
// player-visible and a person presses the button that writes it — see /api/veo/reconcile. Nothing
// here reaches the MatchDay API at all.
//
// CONFINED ACCOUNTS ARE REFUSED, and it costs nothing to arrange: authenticateCrm runs
// assertConfinedRoute over this path and the path is not on the allowlist. A pattern is fleet
// configuration, the same judgement /api/veo/intent already makes.
import { authenticateCrm } from "@/lib/crmAuth";
import { slotKeyOf } from "@/lib/veoSchedule";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HHMM = /^[0-2]\d:[0-5]\d$/;

type Key = { city: string; field: string; weekday: number; hhmm: string };
function keyFrom(src: { city?: unknown; field?: unknown; weekday?: unknown; hhmm?: unknown }): Key | string {
  const city = String(src.city ?? "").trim();
  const field = String(src.field ?? "").trim();
  const weekday = Number(src.weekday);
  const hhmm = String(src.hhmm ?? "").trim();
  if (!city) return "city required";
  // THE RAW field_title, EXACTLY. Not the canonical venue name — 0164's header records why, with
  // the measurement: the canonical name merges two different Westlake pitches onto one key.
  if (!field) return "field required";
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return "weekday must be 0-6";
  if (!HHMM.test(hhmm)) return "hhmm must be HH:MM, wall clock";
  return { city, field, weekday, hhmm };
}

export async function GET(req: Request) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const u = new URL(req.url).searchParams;
  const k = keyFrom({ city: u.get("city"), field: u.get("field"), weekday: u.get("weekday"), hhmm: u.get("hhmm") });
  if (typeof k === "string") return Response.json({ error: k }, { status: 400 });
  const { data, error } = await auth.supabase.from("veo_slot_intent")
    .select("enabled, set_by, set_at")
    .eq("city", k.city).eq("field", k.field).eq("weekday", k.weekday).eq("hhmm", k.hhmm).maybeSingle();
  if (error) return Response.json({ error: error.message }, { status: 500 });

  /* HOW MANY MATCHES IN THIS SLOT CARRY THEIR OWN veo_intent ROW. The panel says this out loud
   * before you stop a pattern, because stopping one LEAVES those standing — they are the
   * adjustments somebody made deliberately and this build does not throw them away.
   * FUTURE ONLY, and the day is compared as TEXT: start_date carries a Z it does not mean. */
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
  let overrides = 0;
  const { data: rows } = await auth.supabase.from("mdapi_matches")
    .select("api_id, city_identifier, field_title, start_date")
    .is("deleted_at", null).eq("city_identifier", k.city).eq("field_title", k.field)
    .gte("start_date", today).limit(1000);
  const inSlot = (rows ?? []).filter((r) => {
    const s2 = slotKeyOf(r.city_identifier, r.field_title, r.start_date);
    return s2 && s2.weekday === k.weekday && s2.hhmm === k.hhmm;
  }).map((r) => r.api_id);
  if (inSlot.length) {
    const { data: own } = await auth.supabase.from("veo_intent").select("match_api_id").in("match_api_id", inSlot);
    overrides = (own ?? []).length;
  }

  // No row = no pattern. Reported explicitly so the caller never has to infer it.
  return Response.json({ ...k, enabled: data?.enabled === true, recorded: !!data, setAt: data?.set_at ?? null,
    futureInSlot: inSlot.length, overrides },
    { status: 200, headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const k = keyFrom(body);
  if (typeof k === "string") return Response.json({ error: k }, { status: 400 });
  const enabled = body.enabled === true;

  if (!enabled) {
    const { error } = await auth.supabase.from("veo_slot_intent").delete()
      .eq("city", k.city).eq("field", k.field).eq("weekday", k.weekday).eq("hhmm", k.hhmm);
    if (error) return Response.json({ error: error.message }, { status: 500 });
    return Response.json({ ok: true, ...k, enabled: false, cleared: true }, { status: 200 });
  }

  const { error } = await auth.supabase.from("veo_slot_intent").upsert(
    { ...k, enabled: true, set_by: "clubhouse:pattern", set_at: new Date().toISOString() },
    { onConflict: "city,field,weekday,hhmm" },
  );
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ ok: true, ...k, enabled: true }, { status: 200 });
}

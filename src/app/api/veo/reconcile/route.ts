// GET /api/veo/reconcile?env=production — the drift between Clubhouse camera intent and the 🎥 in
// the MatchDay match name, for FUTURE matches only.
//
// Ryan's invariant, and everything here serves it:
//   A match whose camera intent is on has 🎥 in its MatchDay name. A match whose intent is off
//   does not.
//
// The pattern in veo_slot_intent can mark a match created next month that nobody ever clicked, so
// something has to close the gap. This is that something, and it is a COUNT — a person presses the
// button that writes. It is not a cron and must never become one: a match name is player-visible,
// and the rule is already written down in this codebase ("A player-visible send must have a human
// behind it — the cron/CRON_SECRET path can't reach it", crm-characterize-test.ts:87).
//
// ── THIS ROUTE WRITES NOTHING ─────────────────────────────────────────────────────────────────
// It returns the list and the exact name each match would get. The CLIENT then PUTs them one at a
// time through /api/matchday/{env}/matches/{id}, which is the estate's only match-name writer:
// one host guard, one EDIT MATCHES gate, one recordWrite per write. Adding a second writer here to
// save a round trip would be trading the thing that makes these writes auditable for latency.
//
// ── THE MIRROR LAG, WHICH IS THE WHOLE DIFFICULTY ─────────────────────────────────────────────
// veoNameSync.ts records it as measured fact: /api/veo reads mdapi_matches, the mirror LAGS a write
// — 6 of 6 landed writes were still absent an hour later — and a surface that trusted it flagged
// every successful write as unsynced and invited a Retry that re-sent the identical name. THREE OF
// THOSE DUPLICATES ARE IN change_log AS `notapplied`.
//
// A reconciler that decided "no 🎥 in this name" from the mirror would re-send every name it wrote
// an hour ago, and running it twice in an afternoon would double-write the lot. So:
//
//   THE MIRROR IS THE PREFILTER. THE LIVE MATCH IS THE DECISION.
//
// The mirror narrows thousands of future matches to a handful of candidates cheaply; every one of
// those is then read back from the MatchDay API and the decision is made on the live name. Run it
// twice and the second pass reads the name the first pass wrote, nameForVeo answers
// {change:false}, and the count is zero. That is the mechanism, and it is why the count and the
// write list are the same list rather than two computations that can disagree.
//
// ── THE STRIP DIRECTION IS LISTED, NEVER WRITTEN ──────────────────────────────────────────────
// A match carrying 🎥 that Clubhouse says is off means either Clubhouse is stale or somebody typed
// a camera into a name by hand. Migration 0100 records that whole cities ran nightly coverage with
// zero emoji, so "Clubhouse says off" is weak evidence. Stripping a player-visible glyph on that
// assumption is not something to do silently, so these are counted and listed for a person to look
// at, and this route offers no way to write them.
import { authenticateCrm } from "@/lib/crmAuth";
import { apiGet } from "@/lib/matchdayStageApi";
import { resolveIntentFor } from "@/lib/veoSchedule";
import { nameForVeo } from "@/lib/veoNameSync";
import { hasCameraEmoji, stripCameraEmoji } from "@/lib/veo";
import { CITY_CODE_TO_DISPLAY } from "@/lib/scheduleReconcile";
import { canonicalVenueName } from "@/lib/venueResolver";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const isEnv = (e: string): e is "production" | "staging" => e === "production" || e === "staging";
/** The operating day, as TEXT. start_date carries a Z it does not mean; never a Date on either side. */
const todayYmd = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());

/* A CEILING ON THE LIVE READS. One GET per candidate is the correct decision and it is also the
 * expensive part, so the candidate set is bounded and the response says when it was truncated
 * rather than quietly reporting a smaller drift than exists. */
const MAX_LIVE_READS = 120;

export async function GET(req: Request) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const env = new URL(req.url).searchParams.get("env") ?? "production";
  if (!isEnv(env)) return Response.json({ error: `unknown environment ${JSON.stringify(env)}` }, { status: 400 });

  const today = todayYmd();
  /* FUTURE ONLY, AND IT IS A TEXT COMPARISON. gte on the YYYY-MM-DD prefix keeps today's later
   * matches in and yesterday's out without constructing a Date at either end. Carry-forward is
   * forward only; nothing here may propose a write against a match that has been played. */
  const rows: { api_id: number; name: string | null; city_identifier: string | null; field_title: string | null; start_date: string | null }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await auth.supabase.from("mdapi_matches")
      .select("api_id, name, city_identifier, field_title, start_date")
      .is("deleted_at", null).eq("is_cancelled", false)
      .gte("start_date", today)
      .order("start_date", { ascending: true })
      .range(from, from + 999);
    if (error) return Response.json({ error: error.message }, { status: 500 });
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }

  const intent = await resolveIntentFor(auth.supabase, rows);

  // THE PREFILTER, ON THE MIRROR. Cheap, and deliberately allowed to be wrong in the safe
  // direction: a lagging mirror can only ADD candidates here, and every one is checked live below.
  const wantsCamera = rows.filter((r) => intent.get(r.api_id)?.enabled === true && !hasCameraEmoji(r.name));
  const carriesCamera = rows.filter((r) => intent.get(r.api_id)?.enabled !== true && hasCameraEmoji(r.name));

  const describe = (r: typeof rows[number]) => ({
    apiId: r.api_id,
    city: CITY_CODE_TO_DISPLAY[r.city_identifier ?? ""] ?? r.city_identifier ?? "—",
    venue: canonicalVenueName(r.field_title ?? "") || (r.field_title ?? "Unknown"),
    date: String(r.start_date ?? "").slice(0, 10),
    time: String(r.start_date ?? "").slice(11, 16),
    name: stripCameraEmoji(r.name),
    fromPattern: intent.get(r.api_id)?.fromPattern === true,
  });

  /* THE LIVE READ, AND IT IS THE DECISION. Whatever the mirror says, the name that matters is the
   * one MatchDay holds right now. A candidate whose live name already carries the camera is
   * dropped here — which is exactly what makes a second run write nothing. */
  const add: (ReturnType<typeof describe> & { nextName: string })[] = [];
  let checked = 0, alreadyLive = 0, unreadable = 0;
  for (const r of wantsCamera) {
    if (checked >= MAX_LIVE_READS) break;
    checked++;
    let liveName: string | null = null;
    try {
      const m = await apiGet<{ name?: string }>(env, `/admin/matches/${r.api_id}`);
      liveName = typeof m?.name === "string" ? m.name : null;
    } catch { unreadable++; continue; }   // a match we cannot read is a match we do not write
    const edit = nameForVeo(liveName, true);
    if (!edit.change) { alreadyLive++; continue; }
    add.push({ ...describe(r), nextName: edit.next });
  }

  return Response.json({
    env, today,
    futureMatches: rows.length,
    add,
    addCount: add.length,
    /* LISTED, NOT TOUCHED. There is no write path for these anywhere in this build. */
    strip: carriesCamera.map(describe),
    stripCount: carriesCamera.length,
    checkedLive: checked,
    /* THE MIRROR-LAG NUMBER, SAID OUT LOUD. Candidates the mirror thought needed a camera whose
     * live name already had one — i.e. writes that landed and have not yet been mirrored. On a
     * second run in the same afternoon this is the whole candidate set and addCount is 0. */
    alreadyMarkedLive: alreadyLive,
    unreadable,
    truncated: wantsCamera.length > checked,
    candidatesBeforeLiveCheck: wantsCamera.length,
  }, { status: 200, headers: { "Cache-Control": "no-store" } });
}

/* GET /api/veo/recent?limit=&filter= — every film that has arrived, newest arrival first. READ ONLY.
 *
 * THE PAGE'S OTHER AXIS. The day view is indexed by the day a match was PLAYED; this is the same
 * recordings ordered by when the FILM ARRIVED. A film that lands today for last Tuesday is
 * invisible on a page organised by Tuesday unless you already knew to go back and look.
 *
 * CITY CONFINEMENT APPLIES, and a new route is exactly where that gets forgotten. veo_recordings
 * carries no city, so the scope is resolved through what the recording points at:
 *
 *   1. a matched recording is scoped by ITS MATCH's city_identifier — the same column, and the same
 *      value, the day route filters on;
 *   2. an unmatched one is scoped by the venue its CODE resolves to (veo_codes.city, mapped back to
 *      a city identifier), because that is the only placement it has;
 *   3. one that resolves to neither is visible ONLY to unconfined accounts. You cannot confine what
 *      you cannot place, and showing it to everyone would leak a recording a confined operator has
 *      no business seeing.
 *
 * A consequence worth stating rather than discovering: no veo_codes row names a Warsaw field, so a
 * Warsaw operator sees an EMPTY list here. That is correct — no recording can arrive for a field no
 * code names — and the page's own note about uncoded camera matches is where that gets explained.
 */

import { authenticateCrm } from "@/lib/crmAuth";
import { CITY_CODE_TO_DISPLAY } from "@/lib/scheduleReconcile";
import { fetchVeoCodeRows } from "@/lib/veoCodes";
import { resolveVeoCodeScored } from "@/lib/veo";
import { veoCodeRowsToMap } from "@/lib/veoCodes";
import { recentState, type RecentState } from "@/lib/veoRecent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 30;

export type RecentRow = {
  id: string;
  recordingId: string;
  subject: string | null;
  videoUrl: string | null;
  receivedAt: string | null;
  state: RecentState;
  queueReason: string | null;
  score: number | null;
  candidateApiIds: number[];
  parsedCode: string | null;
  parsedMatchDate: string | null;
  parsedTimeMinutes: number | null;
  /* THE SLUG, so the page can re-read the title. A title carries a month and a day but never a
   * year; the year comes from the processing date in the slug, exactly as it does at ingest. */
  slug: string;
  /** Where it could be placed — via its match, else via its code. Null when neither resolves. */
  city: string | null;
  /** The match it went into, when it went into one. */
  match: { apiId: number; name: string; venue: string | null; city: string | null; day: string | null } | null;
};

export async function GET(req: Request) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const url = new URL(req.url);
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(url.searchParams.get("limit")) || DEFAULT_LIMIT));
  const filter = url.searchParams.get("filter") === "unposted" ? "unposted" : "all";
  /* A PRESENTATION FILTER, AND NOT THE BOUNDARY. The page's city control narrows what an operator
   * is looking at; confinement decides what they are ALLOWED to look at. They are different things
   * that would collapse into one if the scope were ever taken from this parameter, so it is applied
   * strictly AFTER the session scope below and can only ever narrow further. */
  const cityWanted = url.searchParams.get("city");

  try {
    /* OVER-FETCH, THEN SCOPE, THEN SLICE. The city a recording belongs to is not a column on
     * veo_recordings — it is behind its match or its code — so it cannot be filtered in the first
     * query. Taking `limit` rows and then dropping the out-of-city ones would hand a confined
     * operator a short list and call it the most recent 30. */
    const want = auth.confinedCity || cityWanted ? Math.min(MAX_LIMIT * 4, 800) : limit * 3;
    let q = auth.supabase
      .from("veo_recordings")
      .select("id, recording_id, match_path_slug, email_subject, video_url, received_at, status, queue_reason, matched_api_id, candidate_api_ids, match_score, flagged, posted_by_user_id, parsed_code, parsed_match_date, parsed_time_minutes")
      .order("received_at", { ascending: false })
      .limit(want);
    if (filter === "unposted") q = q.neq("status", "posted");
    const { data, error } = await q;
    if (error) throw new Error(`veo recent: ${error.message}`);
    const raw = data ?? [];

    // The matches these went into, for the name, the venue and the day.
    const apiIds = [...new Set(raw.map((r) => r.matched_api_id as number | null).filter((x): x is number => x != null))];
    const matchById = new Map<number, { apiId: number; name: string; venue: string | null; city: string | null; day: string | null }>();
    if (apiIds.length) {
      const { data: ms } = await auth.supabase
        .from("mdapi_matches")
        .select("api_id, name, field_title, city_identifier, start_date")
        .in("api_id", apiIds);
      for (const m of ms ?? []) {
        matchById.set(m.api_id as number, {
          apiId: m.api_id as number,
          name: (m.name as string | null) ?? `Match ${m.api_id}`,
          venue: (m.field_title as string | null) ?? null,
          city: (m.city_identifier as string | null) ?? null,
          // start_date is a WALL CLOCK; its first ten characters are the match's own local day,
          // which is exactly what the lag subtracts from. No Date is constructed here.
          day: m.start_date ? String(m.start_date).slice(0, 10) : null,
        });
      }
    }

    /* CODE → CITY, RESOLVED THE WAY THE MATCHER RESOLVES IT. An exact map lookup was not enough:
     * `parsed_code` holds what the TITLE said, and the matcher reaches a venue through the fuzzy
     * tiers — "SCISS" is not a veo_codes key, it resolves to SCI by appearing inside "Scissortail
     * Park". Scoping on the exact key left every fuzzily-matched recording unplaced, which for a
     * confined operator means invisible. The scope has to agree with the resolver that placed it. */
    const codeRows = await fetchVeoCodeRows(auth.supabase).catch(() => []);
    const codeMap = veoCodeRowsToMap(codeRows);
    const displayToCode = new Map(Object.entries(CITY_CODE_TO_DISPLAY).map(([code, display]) => [display, code]));
    const cityOfCode = (parsed: string | null): string | null => {
      const field = resolveVeoCodeScored(parsed, codeMap).field;
      return field ? displayToCode.get(field.city) ?? null : null;
    };

    const rows: RecentRow[] = [];
    for (const r of raw) {
      const match = r.matched_api_id != null ? matchById.get(r.matched_api_id as number) ?? null : null;
      const viaMatch = match?.city ?? null;
      const viaCode = cityOfCode(r.parsed_code as string | null);
      const cityCode = viaMatch ?? viaCode;
      // THE SESSION SCOPE FIRST. Unplaceable rows are for unconfined accounts only.
      if (auth.confinedCity && cityCode !== auth.confinedCity) continue;
      /* THEN the operator's own filter, which can only narrow. A row with no placeable city stays
       * visible under "All cities" and is hidden by a specific one — it cannot be claimed for a
       * city nothing links it to. */
      if (cityWanted && (cityCode == null || (CITY_CODE_TO_DISPLAY[cityCode] ?? cityCode) !== cityWanted)) continue;
      rows.push({
        id: r.id as string,
        recordingId: r.recording_id as string,
        subject: (r.email_subject as string | null) ?? null,
        videoUrl: (r.video_url as string | null) ?? null,
        receivedAt: (r.received_at as string | null) ?? null,
        state: recentState({
          status: (r.status as "posted" | "queued" | "dismissed" | null) ?? "queued",
          flagged: r.flagged === true,
          postedByUserId: (r.posted_by_user_id as string | null) ?? null,
        }),
        queueReason: (r.queue_reason as string | null) ?? null,
        score: typeof r.match_score === "number" ? r.match_score : null,
        candidateApiIds: Array.isArray(r.candidate_api_ids) ? (r.candidate_api_ids as unknown[]).map(Number) : [],
        parsedCode: (r.parsed_code as string | null) ?? null,
        parsedMatchDate: (r.parsed_match_date as string | null) ?? null,
        parsedTimeMinutes: typeof r.parsed_time_minutes === "number" ? r.parsed_time_minutes : null,
        slug: (r.match_path_slug as string) ?? "",
        city: cityCode ? (CITY_CODE_TO_DISPLAY[cityCode] ?? cityCode) : null,
        match,
      });
      if (rows.length >= limit) break;
    }

    return Response.json({
      rows,
      limit,
      filter,
      /* `more` is honest about what it knows: there were further rows to consider, not that there
       * are further rows the operator may see. A confined account's tail is unknowable without
       * scoping the whole table. */
      more: raw.length >= want || rows.length >= limit,
      confinedCity: auth.confinedCity ?? null,
    }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    console.error("[veo:recent]", e);
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

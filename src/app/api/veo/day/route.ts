/* GET /api/veo/day?date=YYYY-MM-DD — one day of camera matches and their film. READ ONLY.
 *
 * ONLY THE MATCHES A CAMERA WAS ON. A row exists when the match's field_id is in the field_ids of
 * some veo_codes row, and not otherwise. The camera-emoji helpers in veo.ts are deliberately NOT
 * the selector: hasCameraEmoji reads a glyph an admin typed into a match name, while the code table
 * is what actually decides whether a recording can arrive. Matches whose name carries the emoji but
 * whose field is in no code are counted and returned separately (`emojiWithoutCode`) rather than
 * papered over — that gap is a configuration fact worth seeing, not a row to invent.
 *
 * THE CITY BOUNDARY COMES FROM THE SESSION, never from a query parameter. Warsaw has camera
 * matches, so a confined account reaching this route sees its own city and no other — filtered in
 * SQL, the same way fetchVeoRange does it, not after the fetch.
 *
 * Nothing here writes anything, and nothing here talks to the MatchDay API.
 */

import { authenticateCrm } from "@/lib/crmAuth";
import { CITY_CODE_TO_DISPLAY } from "@/lib/scheduleReconcile";
import { canonicalVenueName } from "@/lib/venueResolver";
import { hasCameraEmoji, stripCameraEmoji } from "@/lib/veo";
import { fetchVeoCodeRows } from "@/lib/veoCodes";
import { buildDayRows, tally, type AssignCandidate, type EmojiOnlyMatch, type VeoDayMatch, type VeoDayRecording } from "@/lib/veoDay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const ISO = /^\d{4}-\d{2}-\d{2}$/;

const fmtTime = (iso: string): { label: string; minutes: number } => {
  // WALL CLOCK. start_date carries a Z it does not mean — it is the local clock at the pitch — so
  // the hour and minute are read off the STRING and no Date is constructed from it.
  const m = /T(\d{2}):(\d{2})/.exec(iso);
  const h = m ? Number(m[1]) : 0;
  const min = m ? Number(m[2]) : 0;
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return { label: `${h12}:${String(min).padStart(2, "0")} ${ampm}`, minutes: h * 60 + min };
};

export async function GET(req: Request) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const url = new URL(req.url);
  const date = url.searchParams.get("date") ?? "";
  if (!ISO.test(date)) return Response.json({ error: "date is required as YYYY-MM-DD" }, { status: 400 });

  try {
    // ---- which fields a camera is on, and under which code ----
    const codeRows = await fetchVeoCodeRows(auth.supabase);
    const codeByField = new Map<number, { code: string; confirmed: boolean }>();
    for (const r of codeRows) {
      for (const f of r.field_ids) {
        // FIRST CODE WINS, and a second one naming the same field is a configuration collision
        // rather than a second row on the page.
        if (!codeByField.has(f)) codeByField.set(f, { code: r.code, confirmed: r.confirmed });
      }
    }

    // ---- the day's matches, city-scoped in SQL ----
    let q = auth.supabase
      .from("mdapi_matches")
      .select("api_id, name, city_identifier, field_id, field_title, start_date, is_cancelled, player_count, max_player_count")
      .is("deleted_at", null)
      .gte("start_date", `${date}T00:00:00`)
      .lte("start_date", `${date}T23:59:59`);
    if (auth.confinedCity) q = q.eq("city_identifier", auth.confinedCity);
    const { data: rows, error } = await q;
    if (error) throw new Error(`veo day: ${error.message}`);

    const matches: VeoDayMatch[] = [];
    /* THE ROWS, NOT A COUNT. This used to be a number, so these matches were counted and thrown
     * away and nothing downstream could show them — the page claimed at its foot that N such
     * matches existed, with no way to see them and no way to check the claim was true. The count
     * is now `.length`, so the number on screen and the rows on screen cannot disagree.
     * SAME SCOPED QUERY, so confinement is inherited rather than re-derived: these come out of the
     * same `rows` the coded matches do, which the session already filtered in SQL. */
    const emojiMatches: EmojiOnlyMatch[] = [];
    for (const r of rows ?? []) {
      const fieldId = r.field_id as number | null;
      const named = fieldId != null ? codeByField.get(fieldId) : undefined;
      if (!named) {
        if (hasCameraEmoji(r.name)) emojiMatches.push({
          apiId: r.api_id as number,
          name: (r.name as string | null) ?? `Match ${r.api_id}`,
          venue: (r.field_title as string | null) ?? null,
          city: (r.city_identifier as string | null) ?? null,
          time: fmtTime(String(r.start_date)),
        });
        continue;
      }
      const t = fmtTime(String(r.start_date));
      const cityCode = (r.city_identifier as string) ?? "";
      matches.push({
        apiId: r.api_id as number,
        name: stripCameraEmoji(r.name),
        city: CITY_CODE_TO_DISPLAY[cityCode] ?? cityCode ?? "—",
        cityCode,
        venue: canonicalVenueName(r.field_title ?? "") || (r.field_title as string) || "Unknown",
        fieldId: fieldId as number,
        code: named.code,
        codeConfirmed: named.confirmed,
        date,
        time: t.label,
        minutes: t.minutes,
        players: (r.player_count as number | null) ?? null,
        capacity: (r.max_player_count as number | null) ?? null,
        cancelled: r.is_cancelled === true,
      });
    }
    matches.sort((a, b) => a.minutes - b.minutes || a.venue.localeCompare(b.venue));

    // ---- the recordings that could belong to this day ----
    // Matched by the DATE THE MATCHER PARSED, plus anything already posted to one of the day's
    // matches (which covers a recording whose parsed date was wrong but whose match is right).
    const ids = matches.map((m) => m.apiId);
    const byDate = auth.supabase
      .from("veo_recordings")
      .select("id, recording_id, email_subject, video_url, received_at, status, queue_reason, matched_api_id, candidate_api_ids, match_score, score_parts, flagged, parsed_code, parsed_match_date, parsed_time_label, parsed_time_minutes, posted_by_user_id")
      .eq("parsed_match_date", date);
    const byMatch = ids.length
      ? auth.supabase
          .from("veo_recordings")
          .select("id, recording_id, email_subject, video_url, received_at, status, queue_reason, matched_api_id, candidate_api_ids, match_score, score_parts, flagged, parsed_code, parsed_match_date, parsed_time_label, parsed_time_minutes, posted_by_user_id")
          .in("matched_api_id", ids)
      : null;
    const [dRes, mRes] = await Promise.all([byDate, byMatch ?? Promise.resolve({ data: [], error: null })]);
    if (dRes.error) throw new Error(`veo day recordings: ${dRes.error.message}`);
    if (mRes.error) throw new Error(`veo day recordings by match: ${mRes.error.message}`);

    const seen = new Set<string>();
    const recordings: VeoDayRecording[] = [];
    for (const r of [...(dRes.data ?? []), ...(mRes.data ?? [])]) {
      const id = r.id as string;
      if (seen.has(id)) continue;
      seen.add(id);
      recordings.push({
        id,
        recordingId: r.recording_id as string,
        subject: (r.email_subject as string | null) ?? null,
        videoUrl: (r.video_url as string | null) ?? null,
        receivedAt: (r.received_at as string | null) ?? null,
        status: (r.status as VeoDayRecording["status"]) ?? "queued",
        queueReason: (r.queue_reason as string | null) ?? null,
        matchedApiId: (r.matched_api_id as number | null) ?? null,
        candidateApiIds: Array.isArray(r.candidate_api_ids) ? (r.candidate_api_ids as unknown[]).map(Number) : [],
        // NULL STAYS NULL. Every row written before 0159 has no score, and that is an absence the
        // page must render as nothing — a 0 here would read as a confident zero.
        score: typeof r.match_score === "number" ? r.match_score : null,
        scoreParts: (r.score_parts as VeoDayRecording["scoreParts"]) ?? null,
        flagged: r.flagged === true,
        parsedCode: (r.parsed_code as string | null) ?? null,
        parsedMatchDate: (r.parsed_match_date as string | null) ?? null,
        parsedTimeLabel: (r.parsed_time_label as string | null) ?? null,
        parsedTimeMinutes: typeof r.parsed_time_minutes === "number" ? r.parsed_time_minutes : null,
        postedByUserId: (r.posted_by_user_id as string | null) ?? null,
      });
    }

    const dayRows = buildDayRows(matches, recordings);

    // Every camera match on the day is assignable. Keyed by api_id so the page can look one up
    // from a stored candidate_api_id without scanning.
    const candidates: Record<number, AssignCandidate> = {};
    for (const m of matches) {
      candidates[m.apiId] = {
        apiId: m.apiId, name: m.name, venue: m.venue, city: m.city,
        time: m.time, minutes: m.minutes, players: m.players, capacity: m.capacity,
        fieldId: m.fieldId, coded: true,
      };
    }
    const placed = new Set(dayRows.flatMap((r) => r.recordings.map((x) => x.id)));
    // A recording that names this date and no match on it. It still belongs to the day — it is
    // exactly the review item the old queue held — but it cannot be a row against a match, and
    // inventing one would break the tally.
    const unplaced = recordings.filter((r) => !placed.has(r.id) && r.status !== "dismissed");

    /* THE MATCHES AN ORPHAN CAN BE ASSIGNED TO. Every camera match on the day, PLUS every match
     * already referenced by an unplaced recording's shortlist — candidate_api_ids can name a match
     * with no row here, which is precisely the recording that most needs assigning by hand. */

    /* AND WHY IT COULD NOT BE PLACED. An unplaced recording that POSTED went somewhere real — a
     * match this page does not list because no veo_codes row names its field. Naming that match
     * and its field turns "could not place" into the configuration gap it actually is. */
    const strayIds = [...new Set(unplaced.flatMap((r) => [r.matchedApiId, ...r.candidateApiIds]).filter((x): x is number => x != null))];
    const strays: Record<number, { apiId: number; name: string; fieldId: number | null; date: string | null }> = {};
    if (strayIds.length) {
      const { data: sm } = await auth.supabase
        .from("mdapi_matches")
        .select("api_id, name, field_id, field_title, city_identifier, start_date, player_count, max_player_count")
        .in("api_id", strayIds);
      for (const m of sm ?? []) {
        const apiId = m.api_id as number;
        const fieldId = (m.field_id as number | null) ?? null;
        strays[apiId] = {
          apiId, name: stripCameraEmoji(m.name), fieldId,
          date: m.start_date ? String(m.start_date).slice(0, 10) : null,
        };
        if (!candidates[apiId]) {
          const t = fmtTime(String(m.start_date));
          const cc = (m.city_identifier as string) ?? "";
          candidates[apiId] = {
            apiId, name: stripCameraEmoji(m.name),
            venue: canonicalVenueName(m.field_title ?? "") || (m.field_title as string) || "Unknown",
            city: CITY_CODE_TO_DISPLAY[cc] ?? cc ?? "—",
            time: t.label, minutes: t.minutes,
            players: (m.player_count as number | null) ?? null,
            capacity: (m.max_player_count as number | null) ?? null,
            fieldId, coded: fieldId != null && codeByField.has(fieldId),
          };
        }
      }
    }

    return Response.json({
      date,
      rows: dayRows,
      tally: tally(dayRows),
      unplaced,
      strays,
      candidates,
      // Every field the code table names, so the page can say whether a stray's field is one.
      codedFields: [...codeByField.keys()],
      cities: [...new Set(dayRows.map((r) => r.city))].sort(),
      emojiMatches,
      confinedCity: auth.confinedCity ?? null,
    });
  } catch (e) {
    console.error("[veo:day]", e);
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

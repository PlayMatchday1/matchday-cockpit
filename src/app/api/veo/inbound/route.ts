// POST /api/veo/inbound — ingest a Veo "ready to watch" email and either post
// the final video link into the matched match's Cockpit thread or file a
// review item. Called by the Google Apps Script running on the Gmail account
// (see scripts/veo-gmail-forwarder.gs).
//
// Auth: a shared secret (VEO_INBOUND_SECRET), sent as `Authorization: Bearer
// <secret>` or `x-veo-secret: <secret>`, constant-time compared. No user
// session — this is machine-to-machine.
//
// Body (JSON): {
//   subject:    string   // e.g. "SC | Jul 24 | 8:00PM is ready to watch!"
//   videoUrl:   string   // the "Watch your video" href (preferred)
//   bodyHtml?:  string   // raw HTML fallback if videoUrl wasn't extracted
//   from?:      string   // "service@veo.co"
//   receivedAt?:string   // ISO timestamp
//   messageId?: string   // Gmail message id (debug only)
// }
//
// Idempotency: the recording id (trailing segment of the URL slug) is UNIQUE.
// We INSERT a claim row FIRST; a duplicate email collides (23505) and returns
// a no-op, so the same recording can never post twice.

import { timingSafeEqual } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  classifyVeo,
  extractRecordingRef,
  isFinalReadyEmail,
  parseVeoSubject,
  processingDateFromSlug,
  resolveMatchDates,
  resolveVeoCode,
  type VeoCandidateRow,
  type VeoFieldCode,
} from "@/lib/veo";
import { getVeoCodesMap } from "@/lib/veoCodes";
import { loadVenueCandidates, postVeoLinkToMatch } from "@/lib/veoPost";

export const runtime = "nodejs";
export const maxDuration = 20;

function constantTimeMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function readSecret(req: Request): string | null {
  const header = req.headers.get("authorization") ?? "";
  if (header.startsWith("Bearer ")) return header.slice("Bearer ".length).trim();
  const x = req.headers.get("x-veo-secret");
  return x ? x.trim() : null;
}

type InboundBody = {
  subject?: unknown;
  videoUrl?: unknown;
  bodyHtml?: unknown;
  from?: unknown;
  receivedAt?: unknown;
  messageId?: unknown;
};

const asStr = (v: unknown): string | null => (typeof v === "string" ? v : null);

// Pull the shareable href out of raw HTML when the caller didn't extract it.
function hrefFromHtml(html: string | null): string | null {
  if (!html) return null;
  const m = /https?:\/\/app\.veo\.co\/matches\/[^\s"'<>)]+/i.exec(html);
  return m ? m[0] : null;
}

function serviceClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceKey) return null;
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Build the per-date candidate loader classifyVeo needs. We pre-load the
// venue's candidate matches for EACH candidate year (the slug year plus the
// prior-year boundary fallback — at most two small day-scoped queries) into a
// map, and hand back a synchronous per-date lookup. classifyVeo drives which
// dates it actually consults; only dates it may ask for are pre-loaded.
async function buildLoader(
  supabase: SupabaseClient,
  subject: string,
  slug: string,
  codes: Record<string, VeoFieldCode>,
): Promise<(finVenueId: number, matchDate: string) => VeoCandidateRow[]> {
  const empty = () => [] as VeoCandidateRow[];
  const parsed = parseVeoSubject(subject);
  if (!parsed.ok) return empty;
  const venue = resolveVeoCode(parsed.value.code, codes);
  if (!venue) return empty;
  const dates = resolveMatchDates(parsed.value, processingDateFromSlug(slug));
  const byDate = new Map<string, VeoCandidateRow[]>();
  for (const d of dates) {
    byDate.set(d, await loadVenueCandidates(supabase, venue.finVenueId, d));
  }
  return (_finVenueId, matchDate) => byDate.get(matchDate) ?? [];
}

export async function POST(req: Request) {
  const secret = process.env.VEO_INBOUND_SECRET;
  if (!secret) {
    console.error("[veo:inbound] VEO_INBOUND_SECRET not configured");
    return Response.json({ error: "Not configured" }, { status: 500 });
  }
  const provided = readSecret(req);
  if (!provided || !constantTimeMatch(provided, secret)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: InboundBody;
  try {
    body = (await req.json()) as InboundBody;
  } catch {
    return Response.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const subject = asStr(body.subject);
  if (!subject) {
    return Response.json({ error: "subject required" }, { status: 400 });
  }

  // Gate: only the FINAL "ready to watch" email. Preview / early-access
  // emails are acknowledged (200) so the Apps Script marks them done, but
  // never ingested.
  if (!isFinalReadyEmail(subject)) {
    return Response.json({ ok: true, ignored: "not_final_email" }, { status: 200 });
  }

  const videoUrl = asStr(body.videoUrl) ?? hrefFromHtml(asStr(body.bodyHtml));
  if (!videoUrl) {
    return Response.json(
      { error: "videoUrl (or bodyHtml with a Veo link) required" },
      { status: 400 },
    );
  }
  const ref = extractRecordingRef(videoUrl);
  if (!ref) {
    return Response.json(
      { error: "Could not extract recording id from videoUrl" },
      { status: 400 },
    );
  }

  const supabase = serviceClient();
  if (!supabase) {
    console.error("[veo:inbound] Supabase env not configured");
    return Response.json({ error: "Not configured" }, { status: 500 });
  }

  const receivedAt = asStr(body.receivedAt);
  const raw = {
    subject,
    from: asStr(body.from),
    videoUrl,
    messageId: asStr(body.messageId),
    receivedAt,
  };

  // Parse + match + post/queue, updating the given row. Shared by the fresh
  // claim path and the dedup self-heal path. The two-message post is an atomic
  // batch keyed on deterministic doc ids, so re-driving a not-yet-'posted'
  // recording safely re-attempts it (writes both, or no-ops if already posted).
  const runDecision = async (rowId: string): Promise<Response> => {
    const codes = await getVeoCodesMap(supabase); // DB map (cached), constant fallback
    const loadCandidates = await buildLoader(supabase, subject, ref.slug, codes);
    const decision = classifyVeo({ subject, slug: ref.slug, loadCandidates, codes });

    const parsedFields = {
      parsed_code: decision.code,
      parsed_match_date: decision.matchDate,
      parsed_time_minutes: decision.timeMinutes,
      parsed_time_label: decision.timeLabel,
    };
    const now = new Date().toISOString();

    if (decision.action === "post") {
      try {
        // Atomic batch: the copy line + the bare URL land together or not at
        // all; we only reach the 'posted' update on a successful commit.
        const posted = await postVeoLinkToMatch({
          supabase,
          recordingId: ref.recordingId,
          apiId: decision.apiId,
          videoUrl,
          sentByUserId: null, // automatic post
        });
        await supabase
          .from("veo_recordings")
          .update({
            ...parsedFields,
            status: "posted",
            queue_reason: null,
            matched_api_id: decision.apiId,
            candidate_api_ids: null,
            firestore_message_id: posted.urlMessageId,
            posted_at: now,
            updated_at: now,
          })
          .eq("id", rowId);
        console.log(
          `[veo:inbound] posted recording=${ref.recordingId} → match=${decision.apiId}`,
        );
        return Response.json(
          { ok: true, status: "posted", matched_api_id: decision.apiId },
          { status: 200 },
        );
      } catch (err) {
        // The atomic batch failed → NOTHING was written (no half-posted
        // state). File it as post_failed carrying the matched candidate, so it
        // surfaces in the queue as a one-click retry rather than being lost.
        console.error(`[veo:inbound] post failed recording=${ref.recordingId}`, err);
        await supabase
          .from("veo_recordings")
          .update({
            ...parsedFields,
            status: "queued",
            queue_reason: "post_failed",
            candidate_api_ids: [decision.apiId],
            updated_at: now,
          })
          .eq("id", rowId);
        return Response.json(
          { ok: true, status: "queued", queue_reason: "post_failed" },
          { status: 200 },
        );
      }
    }

    await supabase
      .from("veo_recordings")
      .update({
        ...parsedFields,
        status: "queued",
        queue_reason: decision.reason,
        candidate_api_ids: decision.candidateApiIds.length ? decision.candidateApiIds : null,
        updated_at: now,
      })
      .eq("id", rowId);
    console.log(`[veo:inbound] queued recording=${ref.recordingId} reason=${decision.reason}`);
    return Response.json(
      { ok: true, status: "queued", queue_reason: decision.reason },
      { status: 200 },
    );
  };

  // ---------- Claim the recording (idempotency) ----------
  const claim = await supabase
    .from("veo_recordings")
    .insert({
      recording_id: ref.recordingId,
      match_path_slug: ref.slug,
      video_url: videoUrl,
      email_subject: subject,
      email_from: asStr(body.from),
      received_at: receivedAt,
      status: "queued",
      raw,
    })
    .select("id")
    .maybeSingle();

  if (!claim.error) {
    return runDecision(claim.data!.id as string);
  }
  if (claim.error.code !== "23505") {
    console.error("[veo:inbound] claim insert failed", claim.error);
    return Response.json({ error: "DB error" }, { status: 500 });
  }

  // Already claimed by a prior email. If it's fully handled ('posted' /
  // 'dismissed'), no-op. Otherwise re-drive — the idempotent two-message post
  // completes a mid-pair partial without duplicating the copy line.
  const existing = await supabase
    .from("veo_recordings")
    .select("id, status")
    .eq("recording_id", ref.recordingId)
    .maybeSingle();
  if (existing.error || !existing.data) {
    console.log(`[veo:inbound] duplicate recording=${ref.recordingId} — no-op`);
    return Response.json({ ok: true, deduped: true }, { status: 200 });
  }
  if (existing.data.status === "posted" || existing.data.status === "dismissed") {
    return Response.json(
      { ok: true, deduped: true, status: existing.data.status },
      { status: 200 },
    );
  }
  console.log(
    `[veo:inbound] recording=${ref.recordingId} re-driving (status=${existing.data.status})`,
  );
  return runDecision(existing.data.id as string);
}

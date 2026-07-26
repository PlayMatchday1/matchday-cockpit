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
  resolveMatchDate,
  resolveVeoCode,
  type VeoCandidateRow,
} from "@/lib/veo";
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
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return null;
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Only hit the DB for candidate matches when the title actually resolves to a
// confirmed-or-not venue + a datable slot; otherwise there's nothing to load.
async function candidatesFor(
  supabase: SupabaseClient,
  subject: string,
  slug: string,
): Promise<VeoCandidateRow[]> {
  const parsed = parseVeoSubject(subject);
  if (!parsed.ok) return [];
  const venue = resolveVeoCode(parsed.value.code);
  if (!venue) return [];
  const matchDate = resolveMatchDate(parsed.value, processingDateFromSlug(slug));
  if (!matchDate) return [];
  return loadVenueCandidates(supabase, venue.finVenueId, matchDate);
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

  // ---------- 1. Claim the recording (idempotency) ----------
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
  if (claim.error) {
    if (claim.error.code === "23505") {
      console.log(`[veo:inbound] duplicate recording=${ref.recordingId} — no-op`);
      return Response.json({ ok: true, deduped: true }, { status: 200 });
    }
    console.error("[veo:inbound] claim insert failed", claim.error);
    return Response.json({ error: "DB error" }, { status: 500 });
  }
  const rowId = claim.data!.id as string;

  // ---------- 2. Parse + match ----------
  const candidates = await candidatesFor(supabase, subject, ref.slug);
  const decision = classifyVeo({
    subject,
    slug: ref.slug,
    loadCandidates: () => candidates,
  });

  const parsedFields = {
    parsed_code: decision.code,
    parsed_match_date: decision.matchDate,
    parsed_time_minutes: decision.timeMinutes,
    parsed_time_label: decision.timeLabel,
  };
  const now = new Date().toISOString();

  // ---------- 3. Post or queue ----------
  if (decision.action === "post") {
    try {
      const posted = await postVeoLinkToMatch({
        supabase,
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
          firestore_message_id: posted.messageId,
          posted_at: now,
          updated_at: now,
        })
        .eq("id", rowId);
      console.log(
        `[veo:inbound] posted recording=${ref.recordingId} → match=${decision.apiId} msg=${posted.messageId}`,
      );
      return Response.json(
        { ok: true, status: "posted", matched_api_id: decision.apiId },
        { status: 200 },
      );
    } catch (err) {
      // Firestore/post failed — never lose the link. File it as post_failed
      // so it lands in the queue for a manual retry.
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

  // Queue.
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
}

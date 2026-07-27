// Server-only IO for the Veo auto-poster: post a video link into a match's
// Firestore thread (+ audit row), and load candidate mdapi matches for a
// venue on a date. Kept apart from src/lib/veo.ts so that file stays pure and
// unit-testable; everything here touches Firestore / Supabase.

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { matchLocalStart, veoMessageText, type VeoCandidateRow } from "@/lib/veo";
import { postMessagePairBatch } from "@/lib/messagePairPost";

export type PostResult = { copyMessageId: string; urlMessageId: string };

// Post the film into Chats/{chatId}/messages as TWO messages (copy line, then
// the bare video URL) via the shared atomic batch writer. Deterministic doc
// ids keyed on the recording make it idempotent; a full replay is a no-op. On
// a real Firestore failure the batch wrote NOTHING and this throws, so the
// caller leaves the recording NOT 'posted' (queued as post_failed) for retry.
export async function postVeoLinkToMatch(args: {
  supabase: SupabaseClient;
  recordingId: string;
  apiId: number;
  videoUrl: string;
  sentByUserId: string | null;
}): Promise<PostResult> {
  const { supabase, recordingId, apiId, videoUrl, sentByUserId } = args;
  const { copyMessageId, urlMessageId } = await postMessagePairBatch({
    supabase,
    chatId: String(apiId),
    copyDocId: `veo-${recordingId}-copy`,
    urlDocId: `veo-${recordingId}-url`,
    copyText: veoMessageText(),
    urlText: videoUrl,
    sentByUserId,
    auditTag: "veo:post",
  });
  return { copyMessageId, urlMessageId };
}

// Load the candidate mdapi rows for a venue on a local date: resolve the
// venue's field_ids via fin_venue_fields, then pull that day's non-deleted
// matches. Date filtering uses start_date (venue-local wall clock at UTC
// offset), so the day's rows fall in [date 00:00Z, date 23:59:59Z]. The pure
// selectVeoMatches() then applies the ±window and re-checks the local date.
export async function loadVenueCandidates(
  supabase: SupabaseClient,
  finVenueId: number,
  matchDate: string,
): Promise<VeoCandidateRow[]> {
  const vf = await supabase
    .from("fin_venue_fields")
    .select("mdapi_field_id")
    .eq("fin_venue_id", finVenueId);
  if (vf.error) throw new Error(`fin_venue_fields query failed: ${vf.error.message}`);
  const fieldIds = (vf.data ?? []).map((r) => r.mdapi_field_id as number);
  if (fieldIds.length === 0) return [];

  const dayStart = `${matchDate}T00:00:00Z`;
  const dayEnd = `${matchDate}T23:59:59Z`;
  const m = await supabase
    .from("mdapi_matches")
    .select("api_id, field_id, start_date, is_cancelled")
    .in("field_id", fieldIds)
    .is("deleted_at", null)
    .gte("start_date", dayStart)
    .lte("start_date", dayEnd);
  if (m.error) throw new Error(`mdapi_matches query failed: ${m.error.message}`);
  return (m.data ?? []) as VeoCandidateRow[];
}

// Convenience: a match's local date + minutes for building an assign-time
// candidate label. Re-exported so route handlers don't reach into veo.ts for
// this one helper.
export { matchLocalStart };

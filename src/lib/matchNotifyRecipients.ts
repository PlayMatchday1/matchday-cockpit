// Server-side recipient resolution for "Notify players". Given a match
// api_id, returns the deduped, phone-validated list of players to text.
//
// Recipient rule (confirmed with ops, 2026-06-16):
//   - mdapi_match_players rows for this match
//   - user_type = 'PLAYER' only (GUEST/ADDITIONAL_SPOT excluded: guests
//     have no separate phone, additional spots are the same booker)
//   - exclude soft-deleted (deleted_at), cancelled (is_cancelled /
//     canceled_at), waitlist (paid_status = 'WAITING'), absent
//   - exclude fakes via isFakePlayerRow (boolean + @matchday.com email)
//   - normalize user_phone_number to E.164; rows with no valid phone are
//     counted (noPhoneCount) but not sent to
//   - DEDUPE by E.164 so one human (e.g. multiple ADDITIONAL_SPOT rows
//     that slipped the type filter, or a re-registration) gets one text
//
// Mirrors the registration filter in mdapiMatchesRead.mapJoinedRow,
// scoped to PLAYER per the feature spec.

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { isFakePlayerRow } from "./mdapiFakePlayer";
import { normalizePhone } from "./phone";

export type NotifyRecipient = {
  userId: number;
  firstName: string | null;
  lastName: string | null;
  phoneE164: string;
};

export type RecipientResolution = {
  recipients: NotifyRecipient[]; // deduped, valid phone, sendable
  noPhoneCount: number; // PLAYER rows excluded for missing/invalid phone
  totalRegistered: number; // non-fake PLAYER rows passing the filter (pre-dedupe)
};

type PlayerRow = {
  user_id: number;
  user_first_name: string | null;
  user_last_name: string | null;
  user_email: string | null;
  user_phone_number: string | null;
  user_is_fake_player: boolean | null;
};

const PAGE = 1000;

export async function resolveMatchNotifyRecipients(
  supabase: SupabaseClient,
  matchApiId: number,
): Promise<RecipientResolution> {
  const rows: PlayerRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("mdapi_match_players")
      .select(
        "user_id, user_first_name, user_last_name, user_email, user_phone_number, user_is_fake_player",
      )
      .eq("match_api_id", matchApiId)
      .eq("user_type", "PLAYER")
      .is("deleted_at", null)
      .is("canceled_at", null)
      .or("is_cancelled.is.null,is_cancelled.eq.false")
      .or("is_absent.is.null,is_absent.eq.false")
      .or("paid_status.is.null,paid_status.neq.WAITING")
      .order("user_id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      throw new Error(`match notify: recipient query failed: ${error.message}`);
    }
    const batch = (data ?? []) as PlayerRow[];
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }

  let totalRegistered = 0;
  let noPhoneCount = 0;
  // Dedupe by E.164. First row for a phone wins (rows are user_id-ordered,
  // so the result is stable across calls — preview matches send).
  const byPhone = new Map<string, NotifyRecipient>();

  for (const r of rows) {
    if (isFakePlayerRow(r)) continue;
    totalRegistered++;
    const e164 = normalizePhone(r.user_phone_number);
    if (!e164) {
      noPhoneCount++;
      continue;
    }
    if (!byPhone.has(e164)) {
      byPhone.set(e164, {
        userId: r.user_id,
        firstName: r.user_first_name,
        lastName: r.user_last_name,
        phoneE164: e164,
      });
    }
  }

  return {
    recipients: [...byPhone.values()],
    noPhoneCount,
    totalRegistered,
  };
}

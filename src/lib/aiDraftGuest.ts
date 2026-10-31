import "server-only"; // no-op under --conditions=react-server
// WHAT A GUEST CODE DEPENDS ON, read fresh: the live membership, this player's slugs across every
// membership they have held, any code under those slugs, and whether staff confirmed it on the thread.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { MatchdayEnv } from "@/lib/matchdayStageApi";
import { confinementRefusal, membershipOf, readPlayer } from "@/lib/membershipRouteCommon";
import { isStaffReply, type DraftMsg } from "@/lib/aiDraftModel";
import { guestCodeFor, staffConfirmedMembership, type GuestFacts } from "@/lib/aiDraftAction";

export async function loadGuestFacts(a: {
  supabase: SupabaseClient; env: MatchdayEnv; playerId: number; threadId: string; confinedCity: string | null;
}): Promise<{ ok: true; facts: GuestFacts } | { ok: false; error: string }> {
  const { supabase, env, playerId, threadId } = a;
  const raw = await readPlayer(env, playerId);
  const refused = await confinementRefusal(env, a.confinedCity, playerId, raw);
  if (refused) return { ok: false, error: refused };
  const live = membershipOf(raw);
  const d = (raw && typeof raw === "object" && "data" in raw ? raw.data : raw) as Record<string, unknown>;
  const sub = (Array.isArray(d?.userSubscriptions) ? (d.userSubscriptions as Record<string, unknown>[]) : []).find((x) => Number(x.id) === live?.id);
  const since = [sub?.activationDate, sub?.createdAt, sub?.currentPeriodStart].find((v): v is string => typeof v === "string") ?? null;
  const subs = await supabase.from("mdapi_subscriptions").select("membership_id, city_member_slug").eq("user_id", playerId);
  if (subs.error) return { ok: false, error: "This member's codes couldn't be checked, so no code was made." };
  const rows = (subs.data ?? []) as { membership_id: number | string | null; city_member_slug: string | null }[];
  const slug = rows.find((x) => Number(x.membership_id) === live?.id)?.city_member_slug ?? null;
  const slugs = [...new Set(rows.map((x) => x.city_member_slug).filter((s): s is string => !!s && /^[A-Za-z]+\d+$/.test(s)))];
  let existingCodes: GuestFacts["existingCodes"] = [];
  if (slugs.length) {
    // Case-insensitive: Hou243FP and HOU363FP both exist.
    const codes = await supabase.from("mdapi_promocodes").select("code, end_date_utc, deleted_at").or(slugs.map((s) => `code.ilike.${guestCodeFor(s)}`).join(","));
    if (codes.error) return { ok: false, error: "This member's codes couldn't be checked, so no code was made." };
    existingCodes = (codes.data ?? []) as GuestFacts["existingCodes"];
  }
  const msgs = await supabase.from("crm_messages").select("id, direction, body, sent_at, is_auto_reply, template_name, auto_sent_draft_id").eq("thread_id", threadId).order("sent_at", { ascending: false }).limit(60);
  if (msgs.error) return { ok: false, error: "This thread couldn't be read, so no code was made." };
  const staffConfirmed = staffConfirmedMembership(((msgs.data ?? []) as DraftMsg[]).filter(isStaffReply).map((m) => m.body ?? ""));
  return { ok: true, facts: { statusRaw: live?.statusRaw ?? null, canceledAt: live?.canceledAt ?? null, since, slug, existingCodes, staffConfirmed, now: Date.now() } };
}

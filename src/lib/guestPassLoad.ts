import "server-only"; // no-op under --conditions=react-server
// THE FACTS BEHIND A GUEST PASS ANSWER (src/lib/guestPass.ts), read from our database copy. No MatchDay
// read here: the membership comes from the profile the caller already read (the draft's context) or
// from one fresh GET /admin/players/{id} (liveGuestMembership, at the moment the tick creates a code).
//
// "Prior or deleted accounts": other mdapi_users rows on the thread's phone, and mdapi_subscriptions rows
// carrying that phone (a deleted account's user row is scrubbed, its subscription rows keep the phone:
// UNKNOWN whether every deletion leaves them, not measured). Every slug those accounts held is checked.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { MatchdayEnv } from "@/lib/matchdayStageApi";
import { membershipOf, readPlayer } from "@/lib/membershipRouteCommon";
import { phoneShapes } from "@/lib/aiDraftModel";
import { toNationalDigits } from "@/lib/phone";
import { statsFor } from "@/lib/promoRedemptions";
import { guestCodeName, type GuestCodeRow, type GuestPassFacts } from "@/lib/guestPass";

const SLUG_RX = /^[A-Za-z]+\d+$/;
export type GuestMembership = { id: number | null; statusRaw: string | null; price: number | null; canceledAt: string | null; since: string | null };

/** The live membership, read fresh. null = the read failed (the caller treats that as "a person decides"). */
export async function liveGuestMembership(env: MatchdayEnv, playerId: number): Promise<GuestMembership | null | "none"> {
  const raw = await readPlayer(env, playerId).catch(() => null);
  if (!raw) return null;
  const live = membershipOf(raw);
  if (!live) return "none";
  const d = (raw && typeof raw === "object" && "data" in raw ? (raw as { data: unknown }).data : raw) as Record<string, unknown>;
  const sub = (Array.isArray(d?.userSubscriptions) ? (d.userSubscriptions as Record<string, unknown>[]) : []).find((x) => Number(x.id) === live.id);
  const since = [sub?.activationDate, sub?.createdAt, sub?.currentPeriodStart].find((v): v is string => typeof v === "string") ?? null;
  return { id: live.id ?? null, statusRaw: live.statusRaw ?? null, price: live.price ?? null, canceledAt: live.canceledAt ?? null, since };
}

export async function loadGuestPassFacts(sb: SupabaseClient, a: {
  playerId: number; threadPhone: string | null; membership: GuestMembership | null; accountConfirmed: boolean; staffConfirmed: boolean; now: number;
}): Promise<GuestPassFacts> {
  const base = { accountConfirmed: a.accountConfirmed, staffConfirmed: a.staffConfirmed, now: a.now, membership: a.membership };
  const failed = (): GuestPassFacts => ({ ...base, slug: null, codes: null });
  const digits = a.threadPhone ? toNationalDigits(a.threadPhone) : null;
  const shapes = digits ? phoneShapes(digits) : [];

  const ids = new Set<number>([a.playerId]);
  if (shapes.length) {
    const users = await sb.from("mdapi_users").select("id").in("phone_number", shapes).limit(20);
    if (users.error) return failed();
    for (const u of users.data ?? []) ids.add(Number(u.id));
  }
  const subsQ = sb.from("mdapi_subscriptions").select("membership_id, user_id, city_member_slug");
  const subs = shapes.length
    ? await subsQ.or(`user_id.in.(${[...ids].join(",")}),phone_number.in.(${shapes.map((s) => `"${s}"`).join(",")})`)
    : await subsQ.in("user_id", [...ids]);
  if (subs.error) return failed();
  const rows = (subs.data ?? []) as { membership_id: number | string | null; user_id: number | string | null; city_member_slug: string | null }[];
  const slug = rows.find((r) => a.membership?.id != null && Number(r.membership_id) === a.membership.id)?.city_member_slug ?? null;
  const slugs = [...new Set(rows.map((r) => r.city_member_slug).filter((s): s is string => !!s && SLUG_RX.test(s)))];
  if (!slugs.length) return { ...base, slug, codes: [] };

  // Case-insensitive: Hou243FP and HOU363FP both exist.
  const codes = await sb.from("mdapi_promocodes").select("api_id, code, end_date_utc, deleted_at").or(slugs.map((s) => `code.ilike.${guestCodeName(s)}`).join(","));
  if (codes.error) return failed();
  const found = (codes.data ?? []) as Omit<GuestCodeRow, "used">[];
  let stats: Awaited<ReturnType<typeof statsFor>> | null = null;
  try { stats = found.length ? await statsFor(sb, found.map((c) => Number(c.api_id)), new Date(a.now)) : new Map(); } catch { stats = null; }
  return {
    ...base, slug,
    codes: found.map((c) => {
      const s = stats?.get(Number(c.api_id));
      return { ...c, api_id: Number(c.api_id), used: s ? s.played + s.upcoming : null };
    }),
  };
}

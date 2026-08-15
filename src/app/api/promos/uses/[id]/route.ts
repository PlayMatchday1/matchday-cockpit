// Who actually redeemed a promo code.
//
// GATED ON can_manage_promos, NOT on the Match Ops read gate the other promo reads use. This route
// returns player NAME, EMAIL and PHONE — identifying a repeat offender is the entire job — so it
// is deliberately narrower than promos/detail. Note the consequence and decide if it is wanted:
// can_manage_promos now also grants sight of player contact details.
//
// FETCHED ON DEMAND. There are 6,260 codes; nothing here runs until a drawer opens.
//
// WHAT PART 0 PROVED. A redemption is a user-match row carrying promocode_id — there is no
// redemption endpoint, and usageCount on the promo detail is an aggregate with nothing behind it.
// The player id SURVIVES account deletion (4 of 3,258 no longer resolve), which is what makes the
// deleted-account state a finding rather than an error.

import { authenticateAdmin } from "@/lib/adminAuth";
import { createClient } from "@supabase/supabase-js";
import type { UseRow } from "@/lib/promoUsesModel";
import { summarise } from "@/lib/promoUsesModel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  if (!auth.canManagePromos) {
    return Response.json({ error: "MANAGE PROMOS is required to see who redeemed a code — this view includes player contact details." }, { status: 403 });
  }
  const { id } = await ctx.params;
  if (!/^\d+$/.test(id)) return Response.json({ error: "promo id must be numeric" }, { status: 400 });
  const promoId = Number(id);

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return Response.json({ error: "Supabase env not configured" }, { status: 500 });
  const sb = createClient(url, key, { auth: { persistSession: false } });

  // 1 — the redemptions themselves
  const { data: raw, error } = await sb
    .from("mdapi_match_players")
    .select("api_id, match_api_id, user_id, user_email, user_first_name, user_last_name, user_phone_number, amount, created_at, is_cancelled")
    .eq("promocode_id", promoId)
    .order("created_at", { ascending: false });
  if (error) return Response.json({ error: error.message }, { status: 500 });
  const rows = raw ?? [];

  // 2 — which of those accounts still EXIST. The id survives deletion, so this resolve is the only
  // way to tell a live account from a deleted one, and it is the whole point of the panel.
  const ids = [...new Set(rows.map((r) => r.user_id).filter((x): x is number => x != null))];
  const alive = new Set<number>();
  for (let i = 0; i < ids.length; i += 500) {
    const { data } = await sb.from("mdapi_users").select("id").in("id", ids.slice(i, i + 500));
    for (const u of data ?? []) alive.add(u.id as number);
  }

  // 3 — the matches, for name / kickoff / city
  const matchIds = [...new Set(rows.map((r) => r.match_api_id).filter((x): x is number => x != null))];
  const matches = new Map<number, { name: string | null; start: string | null; city: string | null }>();
  for (let i = 0; i < matchIds.length; i += 500) {
    const { data } = await sb.from("mdapi_matches").select("api_id, name, start_date, city_identifier").in("api_id", matchIds.slice(i, i + 500));
    for (const m of data ?? []) matches.set(m.api_id as number, { name: m.name as string, start: m.start_date as string, city: m.city_identifier as string });
  }

  const uses: UseRow[] = rows.map((r) => {
    const m = r.match_api_id != null ? matches.get(r.match_api_id) : undefined;
    const deleted = r.user_id != null && !alive.has(r.user_id);
    return {
      id: r.api_id as number,
      playerId: (r.user_id as number) ?? null,
      deleted,
      // A DELETED ACCOUNT'S LAST-KNOWN IDENTITY IS RETURNED, deliberately. The panel exists to
      // answer "is somebody deleting accounts to re-use codes" — hiding who the deleted person
      // was defeats the entire purpose. This is not new exposure: the mirror already holds these
      // values on the user-match row, which is why they survive the account. The panel labels
      // them LAST KNOWN and marks the account deleted rather than presenting them as current.
      name: [r.user_first_name, r.user_last_name].filter(Boolean).join(" ").trim() || null,
      email: (r.user_email as string) ?? null,
      phone: (r.user_phone_number as string) ?? null,
      at: (r.created_at as string) ?? "",
      matchId: (r.match_api_id as number) ?? null,
      match: m?.name ?? null,
      kickoff: m?.start ?? null,
      city: m?.city ?? null,
      amountCents: Math.round(Number(r.amount ?? 0)) || 0,
    };
  });

  // The cap lives on the promo itself and is what the breach is measured against.
  let capPerUser = 0, code: string | null = null, discountType: string | null = null, discountValue: number | null = null;
  try {
    const { apiGet } = await import("@/lib/matchdayStageApi");
    const d = await apiGet<Record<string, unknown>>("production", `/admin/promocodes/${promoId}`);
    capPerUser = Number(d.numberOfUsesPerUser) || 0;
    code = (d.code as string) ?? null;
    discountType = (d.discountType as string) ?? null;
    discountValue = Number(d.discountValue) || 0;
  } catch { /* the uses still render; the cap comparison simply cannot be made */ }

  const summary = summarise(uses, capPerUser);
  return Response.json({
    ok: true, promoId, code, discountType, discountValue, capPerUser,
    uses,
    summary: {
      total: summary.total, distinctUsers: summary.distinctUsers, capPerUser: summary.capPerUser,
      usesPerUser: summary.usesPerUser, worthCents: summary.worthCents,
      breach: summary.breach, breachWorthCents: summary.breachWorthCents,
      breachers: summary.breachers.map((g) => ({ playerId: g.playerId, name: g.name, deleted: g.deleted, uses: g.uses, worthCents: g.worthCents })),
    },
    capKnown: capPerUser > 0,
  });
}

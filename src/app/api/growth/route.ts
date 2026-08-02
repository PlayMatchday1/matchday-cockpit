// GET /api/growth — the Growth tab's single data endpoint.
//
// Reads the mdapi_* mirror + fin_revenue with the service role (paginated,
// read-only, NEVER a write), hands the raw rows to the pure computeGrowth engine
// and returns one compact JSON payload. All the heavy aggregation runs here so
// the client never receives player emails or 100k raw rows.
//
// Gated on can_access_cities via authenticateCities. Cached briefly at the edge
// because the underlying mirror only changes on the sync cron.

import { authenticateCities } from "@/lib/growthAuth";
import { selectAll } from "@/lib/supabasePagination";
import {
  computeGrowth,
  type RawMatch,
  type RawPlayer,
  type RawRevenue,
  type RawSubscription,
  type RawUser,
} from "@/lib/growthAnalytics";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: Request) {
  const auth = await authenticateCities(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const sb = auth.supabase;

  try {
    // All five reads are independent → run them concurrently. Each selectAll
    // paginates 1000/row internally and REQUIRES a stable .order().
    const [matches, players, users, subscriptions, revenue] = await Promise.all([
      selectAll<RawMatch>(() =>
        sb
          .from("mdapi_matches")
          .select("api_id, start_date, city_identifier, field_id, field_title, is_cancelled, deleted_at")
          .order("api_id"),
      ),
      selectAll<RawPlayer>(() =>
        sb
          .from("mdapi_match_players")
          .select(
            "user_id, match_api_id, paid_status, canceled_at, user_is_fake_player, deleted_at, total_amount",
          )
          .order("api_id"),
      ),
      selectAll<RawUser>(() =>
        sb
          .from("mdapi_users")
          .select("id, created_at, completed_sign_up_at, preferable_city_name, is_fake_player")
          .order("id"),
      ),
      selectAll<RawSubscription>(() =>
        sb
          .from("mdapi_subscriptions")
          .select("user_id, city_identifier, activation_date, canceled_at")
          .order("membership_id"),
      ),
      selectAll<RawRevenue>(() =>
        sb.from("fin_revenue").select("month, city, type, net").order("id"),
      ),
    ]);

    // Raw counts for the verification report (Part 10 #12).
    const playersLive = players.filter((p) => !p.deleted_at).length;
    const usersNonFake = users.filter((u) => !u.is_fake_player);
    const rowCounts = {
      matchesTotal: matches.length,
      matchesLive: matches.filter((m) => !m.deleted_at).length,
      playersTotal: players.length,
      playersLive,
      fakeLiveRows: players.filter((p) => !p.deleted_at && p.user_is_fake_player).length,
      fakeLivePct:
        playersLive > 0
          ? players.filter((p) => !p.deleted_at && p.user_is_fake_player).length / playersLive
          : 0,
      waitingLiveNonFake: players.filter(
        (p) => !p.deleted_at && !p.user_is_fake_player && p.paid_status === "WAITING",
      ).length,
      usersTotal: users.length,
      usersNonFake: usersNonFake.length,
      usersFake: users.length - usersNonFake.length,
      usersCompletedNonFake: usersNonFake.filter((u) => u.completed_sign_up_at).length,
      subscriptions: subscriptions.length,
      finRevenue: revenue.length,
    };

    const data = computeGrowth({
      matches,
      players,
      users,
      subscriptions,
      revenue,
      now: new Date().toISOString(),
      rowCounts,
    });

    return Response.json(data, {
      status: 200,
      headers: { "Cache-Control": "private, max-age=60, stale-while-revalidate=300" },
    });
  } catch (e) {
    console.error("[api/growth] failed", e);
    return Response.json({ error: "Failed to compute growth data" }, { status: 500 });
  }
}

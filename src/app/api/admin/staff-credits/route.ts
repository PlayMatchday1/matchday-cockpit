/* GET /api/admin/staff-credits — CREDITS GIVEN BY STAFF (Ryan, 2026-10-21). Admins only. Read-only.
 *
 * Every credit change in change_log (lib/staffCredits), with each player's name from mdapi_users so
 * the page can show and search it. No MatchDay API call: change_log and our database copy only.
 * The E2E service account is refused whatever its row says (keyed on email, CLAUDE.md "Permissions").
 */

import { authenticateAdmin } from "@/lib/adminAuth";
import { E2E_SERVICE_EMAIL } from "@/lib/matchOpsAuth";
import { selectAll } from "@/lib/supabasePagination";
import { creditEntries, type LogRowIn } from "@/lib/staffCredits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  if (auth.email.toLowerCase() === E2E_SERVICE_EMAIL) return Response.json({ error: "Service accounts cannot read this" }, { status: 403 });
  try {
    const sb = auth.supabase;
    const rows = await selectAll<LogRowIn>(() => sb.from("change_log")
      .select("id, created_at, actor_email, actor_name, source, env, endpoint, outcome, changes")
      .like("endpoint", "/admin/players/%/profile").order("created_at").order("id"));
    const entries = creditEntries(rows);
    const ids = [...new Set(entries.map((e) => e.playerId).filter((x): x is number => x != null))];
    const names: Record<number, string> = {};
    /* WHO THE PLAYER IS, for the tags: Warsaw (the licensee) and our own test or fill accounts are
     * listed like everyone else but tagged, because the US credit liability leaves them out. */
    const tags: Record<number, "warsaw" | "test"> = {};
    for (let i = 0; i < ids.length; i += 300) {
      const { data, error } = await sb.from("mdapi_users").select("id, first_name, last_name, email, is_fake_player, preferable_city_name").in("id", ids.slice(i, i + 300));
      if (error) throw new Error(`mdapi_users: ${error.message}`);
      for (const u of data ?? []) {
        names[u.id as number] = [u.first_name, u.last_name].filter(Boolean).join(" ").trim();
        if (u.is_fake_player || /@matchday\.|@playmatchday\./i.test(String(u.email ?? ""))) tags[u.id as number] = "test";
        else if (u.preferable_city_name === "Warsaw") tags[u.id as number] = "warsaw";
      }
    }
    return Response.json({ entries, names, tags }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[api/admin/staff-credits] failed", e instanceof Error ? e.message : e);
    return Response.json({ error: "Couldn't read the credit records." }, { status: 500 });
  }
}

// POST /api/inventory/delete-manager — admin-only. Removes EVERY row for
// one manager (same normalized name + city), for "Delete all reports from
// this manager". Body: { name, city }.
//
// Admin-gated + service-role like the single-row routes; never broadens
// the table's RLS lockdown. The normalized match (trim / collapse spaces /
// lowercase) isn't expressible in a simple SQL equality, so the route
// fetches the candidate rows and deletes the matched ids by id.

import { authenticateAdmin } from "@/lib/adminAuth";
import { rowsForManager } from "@/lib/inventory";

export const runtime = "nodejs";
export const maxDuration = 10;

export async function POST(req: Request) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const body = (await req.json().catch(() => null)) as
    | { name?: unknown; city?: unknown }
    | null;
  const name = typeof body?.name === "string" ? body.name : "";
  const city = typeof body?.city === "string" ? body.city : "";
  if (!name.trim() || !city.trim()) {
    return Response.json(
      { error: "name and city are required." },
      { status: 400 },
    );
  }

  // Fetch id/name/city and match on the normalized manager key.
  const all = await auth.supabase
    .from("inventory_submissions")
    .select("id, name, city");
  if (all.error) {
    console.error("[inventory:delete-manager] read failed", all.error);
    return Response.json({ error: "DB error" }, { status: 500 });
  }
  const ids = rowsForManager(
    (all.data ?? []) as { id: string; name: string; city: string }[],
    name,
    city,
  ).map((r) => r.id);

  if (ids.length === 0) {
    return Response.json({ ok: true, removed: 0 }, { status: 200 });
  }

  const del = await auth.supabase
    .from("inventory_submissions")
    .delete()
    .in("id", ids)
    .select("id");
  if (del.error) {
    console.error("[inventory:delete-manager] delete failed", del.error);
    return Response.json({ error: "DB error" }, { status: 500 });
  }

  console.log(
    `[inventory:delete-manager] "${name}"/"${city}" removed=${del.data?.length ?? 0} by=${auth.appUserId}`,
  );
  return Response.json({ ok: true, removed: del.data?.length ?? 0 }, { status: 200 });
}

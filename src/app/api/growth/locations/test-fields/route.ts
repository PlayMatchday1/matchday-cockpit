// /api/growth/locations/test-fields: the saved TEST pins on Growth > Locations > Map (migration 0232,
// growth_test_fields). Supabase only. NEVER A REAL FIELD: nothing else in the Clubhouse reads this table.
//
//   GET     the live pins (not removed), oldest first. Anyone with Growth.
//   POST    { name, lat, lng, query? } adds one. Admin only.
//   DELETE  ?id=<uuid> removes one (soft: removed_at / removed_by_email). Admin only.
//
// Writes: read before, write, read back, LANDED / FAILED / NOT APPLIED from the read-back, never
// from the status alone. No retry. Each one is logged to change_log.

import { randomUUID } from "node:crypto";
import { authenticateCapability } from "@/lib/capabilityAuth";
import { recordWrite, supabaseLogStore } from "@/lib/changeLog";
import { STATE_LABEL } from "@/lib/changeLogModel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TABLE = "growth_test_fields";
const MISSING = "The test fields table is not in the database yet (migration 0232).";
const missingTable = (msg: string) => /growth_test_fields/.test(msg) && /does not exist|schema cache|not find/i.test(msg);

export type TestFieldRow = {
  id: string; name: string; lat: number; lng: number; query: string | null;
  created_by_email: string; created_by_name: string | null; created_at: string;
};

export async function GET(req: Request) {
  const auth = await authenticateCapability(req, "growth");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { data, error } = await auth.supabase.from(TABLE)
    .select("id,name,lat,lng,query,created_by_email,created_by_name,created_at")
    .is("removed_at", null).order("created_at").limit(200);
  if (error) {
    if (missingTable(error.message)) return Response.json({ ready: false, error: MISSING, pins: [], canEdit: false });
    return Response.json({ error: error.message }, { status: 502 });
  }
  return Response.json({ ready: true, pins: (data ?? []) as TestFieldRow[], canEdit: auth.isAdmin }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  const auth = await authenticateCapability(req, "growth");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  if (!auth.isAdmin) return Response.json({ outcome: "FAILED", error: "Saving a test field is admin only. Nothing was written." }, { status: 403 });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return Response.json({ outcome: "FAILED", error: "Body is not JSON. Nothing was written." }, { status: 400 }); }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const lat = Number(body.lat), lng = Number(body.lng);
  const query = typeof body.query === "string" && body.query.trim() ? body.query.trim().slice(0, 200) : null;
  if (!name || name.length > 80) return Response.json({ outcome: "FAILED", error: "Give the test field a name (80 characters at most). Nothing was written." }, { status: 400 });
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) {
    return Response.json({ outcome: "FAILED", error: "lat and lng must both be valid coordinates. Nothing was written." }, { status: 400 });
  }

  const sb = auth.supabase;
  const id = randomUUID();
  const fullName = typeof auth.row.full_name === "string" && auth.row.full_name.trim() ? auth.row.full_name.trim() : null;
  const row = { id, name, lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6, query, created_by_email: auth.email, created_by_name: fullName };
  const read = async () => {
    const { data, error } = await sb.from(TABLE).select("*").eq("id", id).maybeSingle();
    if (error) throw new Error(error.message);
    return (data ?? {}) as Record<string, unknown>;
  };
  const res = await recordWrite(
    {
      env: "production", source: "Growth: test field", actorName: fullName ?? auth.email, actorEmail: auth.email,
      saveId: randomUUID(), matchId: null, matchName: null,
      method: "POST", path: `/growth/locations/test-fields/${id}`,
      body: { name: row.name, lat: row.lat, lng: row.lng, query }, keys: ["name", "lat", "lng", "query"], label: (k) => `Test field ${row.name}: ${k}`,
      applied: (_b, after) => after.id === id && after.name === row.name && after.removed_at == null,
    },
    {
      readResource: read,
      write: async () => {
        const { error } = await sb.from(TABLE).insert(row);
        if (error) throw Object.assign(new Error(missingTable(error.message) ? MISSING : error.message), { name: "WriteFailedError" });
      },
      now: () => new Date().toISOString(),
    },
    supabaseLogStore(),
  );
  return Response.json({ outcome: STATE_LABEL[res.outcome], error: res.error?.message ?? null, id, logRecorded: res.logged },
    { status: res.outcome === "landed" ? 200 : res.error ? 500 : 409 });
}

export async function DELETE(req: Request) {
  const auth = await authenticateCapability(req, "growth");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  if (!auth.isAdmin) return Response.json({ outcome: "FAILED", error: "Removing a test field is admin only. Nothing was written." }, { status: 403 });
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(id)) return Response.json({ outcome: "FAILED", error: "id is required. Nothing was written." }, { status: 400 });

  const sb = auth.supabase;
  const read = async () => {
    const { data, error } = await sb.from(TABLE).select("*").eq("id", id).maybeSingle();
    if (error) throw new Error(error.message);
    return (data ?? {}) as Record<string, unknown>;
  };
  const before = await read().catch(() => ({} as Record<string, unknown>));
  if (before.id == null) return Response.json({ outcome: "NOT APPLIED", error: "That test field no longer exists." }, { status: 409 });
  if (before.removed_at != null) return Response.json({ outcome: "NOT APPLIED", error: "That test field was already removed." }, { status: 409 });

  const now = new Date().toISOString();
  const res = await recordWrite(
    {
      env: "production", source: "Growth: test field", actorName: auth.email, actorEmail: auth.email,
      saveId: randomUUID(), matchId: null, matchName: null,
      method: "DELETE", path: `/growth/locations/test-fields/${id}`,
      body: { removed_at: now, removed_by_email: auth.email }, keys: ["removed_at", "removed_by_email"],
      label: (k) => `Test field ${String(before.name)}: ${k.replace(/_/g, " ")}`,
      applied: (_b, after) => after.removed_at != null && after.removed_by_email === auth.email,
    },
    {
      readResource: read,
      write: async () => {
        const { error } = await sb.from(TABLE).update({ removed_at: now, removed_by_email: auth.email }).eq("id", id).is("removed_at", null);
        if (error) throw Object.assign(new Error(error.message), { name: "WriteFailedError" });
      },
      now: () => now,
    },
    supabaseLogStore(),
  );
  return Response.json({ outcome: STATE_LABEL[res.outcome], error: res.error?.message ?? null, logRecorded: res.logged },
    { status: res.outcome === "landed" ? 200 : res.error ? 500 : 409 });
}

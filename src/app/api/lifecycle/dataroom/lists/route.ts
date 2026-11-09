// /api/lifecycle/dataroom/lists — the Data Room's saved lists (migration 0267, dataroom_saved_lists).
// A saved list is its FILTERS and a name, never its players, so opening one always runs fresh.
//
//   GET     the saved lists, oldest first. Anyone with Lifecycle.
//   POST    { name, tab, filters } saves one. Anyone with Lifecycle.
//   DELETE  ?id=<uuid> removes one (soft: removed_at / removed_by_email). Anyone with Lifecycle.
//
// Writes: read before, write, read back; LANDED / FAILED / NOT APPLIED from the read-back, never from
// the status alone. No retry. Each one is logged to change_log. Supabase only.

import { randomUUID } from "node:crypto";
import { authenticateLifecycle } from "@/lib/lifecycleAuth";
import { recordWrite, supabaseLogStore } from "@/lib/changeLog";
import { STATE_LABEL } from "@/lib/changeLogModel";
import { chicagoToday, cleanNever, cleanPlayed } from "@/lib/dataRoomLists";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TABLE = "dataroom_saved_lists";
const MISSING = "Saved lists are not in the database yet (migration 0267).";
const missingTable = (msg: string) => /dataroom_saved_lists/.test(msg) && /does not exist|schema cache|not find/i.test(msg);

export type SavedListRow = { id: string; name: string; tab: "played" | "never"; filters: unknown; created_by_email: string; created_at: string };

export async function GET(req: Request) {
  const auth = await authenticateLifecycle(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { data, error } = await auth.supabase.from(TABLE)
    .select("id,name,tab,filters,created_by_email,created_at").is("removed_at", null).order("created_at").limit(100);
  if (error) {
    if (missingTable(error.message)) return Response.json({ ready: false, error: MISSING, lists: [] });
    return Response.json({ error: error.message }, { status: 502 });
  }
  return Response.json({ ready: true, lists: (data ?? []) as SavedListRow[] }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  const auth = await authenticateLifecycle(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return Response.json({ outcome: "FAILED", error: "Body is not JSON. Nothing was written." }, { status: 400 }); }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 80) return Response.json({ outcome: "FAILED", error: "Give the list a name (80 characters at most). Nothing was written." }, { status: 400 });
  const tab = body.tab === "never" ? "never" : body.tab === "played" ? "played" : null;
  if (!tab) return Response.json({ outcome: "FAILED", error: "tab must be played or never. Nothing was written." }, { status: 400 });
  // Stored exactly as the list will read it back, so a saved list cannot hold a filter the page ignores.
  const filters = tab === "played" ? cleanPlayed(body.filters) : cleanNever(body.filters, chicagoToday());

  const sb = auth.supabase;
  const id = randomUUID();
  const row = { id, name, tab, filters, created_by_email: auth.email };
  const read = async () => {
    const { data, error } = await sb.from(TABLE).select("*").eq("id", id).maybeSingle();
    if (error) throw new Error(error.message);
    return (data ?? {}) as Record<string, unknown>;
  };
  const res = await recordWrite(
    {
      env: "production", source: "Data Room: saved list", actorName: auth.email, actorEmail: auth.email,
      saveId: randomUUID(), matchId: null, matchName: null,
      method: "POST", path: `/lifecycle/data-room/lists/${id}`,
      body: { name, tab, filters }, keys: ["name", "tab", "filters"], label: (k) => `Saved list ${name}: ${k}`,
      applied: (_b, after) => after.id === id && after.name === name && after.removed_at == null,
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
  const auth = await authenticateLifecycle(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(id)) return Response.json({ outcome: "FAILED", error: "id is required. Nothing was written." }, { status: 400 });
  const sb = auth.supabase;
  const read = async () => {
    const { data, error } = await sb.from(TABLE).select("*").eq("id", id).maybeSingle();
    if (error) throw new Error(error.message);
    return (data ?? {}) as Record<string, unknown>;
  };
  const before = await read().catch(() => ({} as Record<string, unknown>));
  if (before.id == null) return Response.json({ outcome: "NOT APPLIED", error: "That list no longer exists." }, { status: 409 });
  if (before.removed_at != null) return Response.json({ outcome: "NOT APPLIED", error: "That list was already removed." }, { status: 409 });
  const now = new Date().toISOString();
  const res = await recordWrite(
    {
      env: "production", source: "Data Room: saved list", actorName: auth.email, actorEmail: auth.email,
      saveId: randomUUID(), matchId: null, matchName: null,
      method: "DELETE", path: `/lifecycle/data-room/lists/${id}`,
      body: { removed_at: now, removed_by_email: auth.email }, keys: ["removed_at", "removed_by_email"],
      label: (k) => `Saved list ${String(before.name)}: ${k.replace(/_/g, " ")}`,
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

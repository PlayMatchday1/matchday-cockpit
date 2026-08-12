// Phase 26 — Slate Review notes persist (table: slate_notes, migration 0119).
//
// A to-do list for the weekly slate meeting. GET lists a city's rows; POST appends one; DELETE
// removes one for good. ADD AND DELETE ONLY — there is no edit path, by design: a note that is
// wrong gets deleted and retyped, so `raw` always means "what someone actually typed".
//
// AUTH: can_access_matchops for READ **and** WRITE (authenticateMatchOpsRead). This is Clubhouse's
// own scratch data, not a MatchDay API write — so there is deliberately NO recordWrite/change_log
// entry here. change_log is the audit of writes that leave for the MatchDay API; putting note
// churn in it would bury the writes that actually reach players.
//
// THE PARSE HAPPENS HERE, on the raw text, using the SAME pure parser the input readout uses
// (slateCapture.parseCapture) — the client posts what was typed plus the city's field list, never
// a pre-parsed row. One parser, one behaviour, and the stored `raw` is always the typed string.

import { authenticateMatchOpsRead } from "@/lib/matchOpsAuth";
import { makeServerClient } from "@/lib/supabaseServer";
import { parseCapture } from "@/lib/slateCapture";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export type SlateNoteRow = {
  id: string; city: string; kind: "proposal" | "note"; raw: string;
  day: string | null; timeTxt: string | null; timeMin: number | null; fieldTxt: string | null;
  weekStart: string; createdBy: string; createdAt: string;
};

const toRow = (r: Record<string, unknown>): SlateNoteRow => ({
  id: String(r.id), city: r.city as string, kind: r.kind as "proposal" | "note", raw: r.raw as string,
  day: (r.day as string) ?? null, timeTxt: (r.time_txt as string) ?? null,
  timeMin: (r.time_min as number) ?? null, fieldTxt: (r.field_txt as string) ?? null,
  weekStart: String(r.week_start).slice(0, 10), createdBy: (r.created_by as string) ?? "",
  createdAt: r.created_at as string,
});

// Every row for the city, newest first. NOT week-filtered — notes stay visible whatever week is
// selected; the client hides proposals whose week_start isn't the selected one.
export async function GET(req: Request) {
  const auth = await authenticateMatchOpsRead(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const city = (new URL(req.url).searchParams.get("city") ?? "").trim();
  if (!city) return Response.json({ error: "city required" }, { status: 400 });
  const sb = makeServerClient();
  const { data, error } = await sb.from("slate_notes").select("*").eq("city", city).order("created_at", { ascending: false });
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ notes: (data ?? []).map(toRow) });
}

export async function POST(req: Request) {
  const auth = await authenticateMatchOpsRead(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const body = (await req.json().catch(() => null)) as
    { city?: string; raw?: string; weekStart?: string; fields?: string[] } | null;
  const city = (body?.city ?? "").trim();
  const raw = (body?.raw ?? "").trim();
  const weekStart = (body?.weekStart ?? "").trim();
  if (!city) return Response.json({ error: "city required" }, { status: 400 });
  if (!raw) return Response.json({ error: "raw text required" }, { status: 400 });
  if (!YMD.test(weekStart)) return Response.json({ error: "weekStart must be YYYY-MM-DD" }, { status: 400 });

  // Same parser as the live readout under the input — so what the operator was told would happen
  // is what gets stored. A miss falls back to a note, verbatim; nothing is discarded.
  const parsed = parseCapture(raw, Array.isArray(body?.fields) ? body.fields : []);
  const insert = parsed && parsed.kind === "slot"
    ? { city, kind: "proposal" as const, raw, day: parsed.day, time_txt: parsed.time, time_min: parsed.min, field_txt: parsed.fieldTxt }
    : { city, kind: "note" as const, raw, day: null, time_txt: null, time_min: null, field_txt: null };

  const sb = makeServerClient();
  const { data, error } = await sb.from("slate_notes")
    .insert({ ...insert, week_start: weekStart, created_by: auth.email })
    .select("*").single();
  // The row is returned so the client can append the SERVER's row — it never renders an
  // optimistic one, so nothing appears that isn't actually stored.
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ note: toRow(data as Record<string, unknown>) });
}

// HARD delete. No soft delete, no restore.
export async function DELETE(req: Request) {
  const auth = await authenticateMatchOpsRead(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const id = (new URL(req.url).searchParams.get("id") ?? "").trim();
  if (!id) return Response.json({ error: "id required" }, { status: 400 });
  const sb = makeServerClient();
  const { error } = await sb.from("slate_notes").delete().eq("id", id);
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ ok: true, deleted: id });
}

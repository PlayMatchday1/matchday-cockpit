// POST /api/applications/contact — set a contact's status or owner. THE ONLY WRITE THIS PAGE HAS.
//
// OUTREACH STATE ATTACHES TO THE PERSON. The key is (stream, lower(email)) so a second application
// never resets someone's status — 25 emails have more than one submission and one has ten.
//
// NO BULK ACTION EXISTS, deliberately. With 66 uncontacted the temptation is a "mark all
// contacted" button, and pressing it destroys the only signal on the page: the difference between
// someone we have spoken to and someone we have not. One person at a time or not at all.
//
// NOTHING INTO change_log — that is the audit of writes reaching the MatchDay API, and outreach is
// Clubhouse's own scratch data. NO EMAIL IN ANY ERROR: the address is the primary key here, so a
// failure quotes the stream and the status, never the person.

import { authenticateMatchOpsRead } from "@/lib/matchOpsAuth";
import { makeServerClient } from "@/lib/supabaseServer";
import { STATUSES, type Status } from "@/lib/webSubmissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const auth = await authenticateMatchOpsRead(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const body = (await req.json().catch(() => null)) as
    { stream?: string; email?: string; status?: string; owner?: string | null; notes?: string | null } | null;

  const stream = body?.stream === "partner" ? "partner" : body?.stream === "team" ? "team" : null;
  const email = String(body?.email ?? "").trim().toLowerCase();
  if (!stream) return Response.json({ error: "stream must be 'team' or 'partner'" }, { status: 400 });
  if (!email || !email.includes("@")) return Response.json({ error: "a contact email is required" }, { status: 400 });

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body?.status !== undefined) {
    if (!STATUSES.includes(body.status as Status)) {
      // The value is ours to validate; it is not PII, so it may appear.
      return Response.json({ error: `status must be one of ${STATUSES.join(", ")}` }, { status: 400 });
    }
    patch.status = body.status;
  }
  if (body?.owner !== undefined) patch.owner = body.owner === null ? null : String(body.owner).slice(0, 80);
  if (body?.notes !== undefined) patch.notes = body.notes === null ? null : String(body.notes).slice(0, 4000);
  if (Object.keys(patch).length === 1) return Response.json({ error: "nothing to change" }, { status: 400 });

  const sb = makeServerClient();

  /* CONFINEMENT ON A WRITE IS NOT THE READ'S FILTER. A city manager may only touch a contact whose
   * submissions are in their city, and that is checked against the DATABASE here rather than
   * trusted from whatever the client had on screen. Deny by default: a contact with no resolvable
   * city cannot be proved in scope. */
  if (auth.confinedCity) {
    const { data, error } = await sb.from("web_submissions")
      .select("city_code").eq("stream", stream).eq("email", email);
    if (error) return Response.json({ error: "scope check failed" }, { status: 500 });
    const inScope = (data ?? []).some((r) => r.city_code === auth.confinedCity);
    if (!inScope) return Response.json({ error: "That contact is not in your city." }, { status: 403 });
  }

  // UPSERT so a first touch creates the row. status defaults to 'New' in the table, so a row that
  // only ever received an owner still reads as uncontacted rather than as nothing.
  const { error } = await sb.from("web_contacts")
    .upsert({ stream, email, ...patch }, { onConflict: "stream,email" });
  if (error) return Response.json({ error: "could not save that change" }, { status: 500 });

  // READ IT BACK. A 2xx is not evidence the write landed.
  const { data: after, error: rErr } = await sb.from("web_contacts")
    .select("status,owner,notes,updated_at").eq("stream", stream).eq("email", email).maybeSingle();
  if (rErr || !after) return Response.json({ verdict: "UNKNOWN", error: "saved, but could not read it back" }, { status: 200 });

  const landed =
    (patch.status === undefined || after.status === patch.status)
    && (patch.owner === undefined || (after.owner ?? null) === (patch.owner ?? null));
  return Response.json({ verdict: landed ? "LANDED" : "NOT APPLIED", contact: after });
}

// POST /api/admin/fields/assign — the ONLY write path for a field-ID → venue link.
//
// ══ TWO LOGS, AND THEY ARE NOT REDUNDANT ══════════════════════════════════════
//
// This route writes BOTH `change_log` and `fin_change_log` for one assignment.
// That is deliberate. DO NOT CONSOLIDATE THEM — each holds something the other
// structurally cannot, and dropping either loses a fact:
//
//   change_log      — THE VERDICT. Written through recordWrite, which reads the
//                     resource BEFORE the write, writes, reads it AFTER, and
//                     classifies LANDED / FAILED / NOT APPLIED / UNKNOWN from
//                     the read-back. A 2xx does not mean the write landed; this
//                     is the only table that records whether it did, because it
//                     is the only one written by something that went and looked.
//                     fin_change_log has no column for an outcome and its writer
//                     never re-reads.
//
//   fin_change_log  — THE HISTORY OF THE TABLE. Migration 0130 widened its CHECK
//                     allowlist specifically to accept `fin_venue_fields`, and
//                     the counts_as_regular_play toggle on Finance → Field Costs
//                     already writes here. Every change to a fin_venue_fields row
//                     belongs in ONE place and this is that place. Sending only
//                     this route's writes to change_log would split the table's
//                     history across two tables at the date a second writer was
//                     added — exactly the seam that makes an audit unreadable a
//                     year later.
//
// So: the verdict lives in change_log, the history lives in fin_change_log, and
// the response reports whether EACH landed. A logging hole is loud, never silent.
//
// ══ WHY THIS TABLE NEEDED A LOG AT ALL ════════════════════════════════════════
// `fin_venue_fields` has no `updated_at` and, until now, its writes reached no
// log. On 2026-08-24 a flag flipped on it with no record, moved ATH Pearland's
// match count and cost across every Finance surface, and sent three separate
// reports down the wrong path. That is what these two inserts exist to prevent.
//
// ══ WHAT IT WILL NOT DO ═══════════════════════════════════════════════════════
// It will not re-point or unlink an existing mapping, will not infer a venue from
// a name, and will not set a rate on a venue it creates — per_match_rate and
// cost_per_match stay NULL so a new pitch reports as UNTRACKED rather than free.
// Every refusal lives in validateAssignment and is asserted offline.

import { randomUUID } from "node:crypto";
import { authenticateAdmin } from "@/lib/adminAuth";
import { recordWrite, supabaseLogStore } from "@/lib/changeLog";
import type { Change } from "@/lib/changeLogModel";
import { fieldAggregate, fieldsPayload, invalidateFieldAggregate } from "@/lib/fieldIdAdminServer";
import { previewAssignment, validateAssignment, type AssignRequest } from "@/lib/fieldIdAdmin";
import type { SupabaseClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LINK_COLS = "fin_venue_id, mdapi_field_id, field_title_at_link, counts_as_regular_play, created_at";
const VENUE_COLS =
  "id, venue_name, city, is_active, billing_type, per_match_rate, cost_per_match, charge_on_cancel, bills_per_reservation";

/** The fin_change_log insert. Best-effort and it NEVER throws over the write: the
 *  write already happened, and a logging outage must not turn a landed edit into an
 *  error the operator would retry into a duplicate. Returns whether it landed so the
 *  response can say so. Mirrors financeAudit.logChange, which runs in the browser
 *  against the anon client; this one runs server-side against the service role. */
async function finLog(
  sb: SupabaseClient,
  entry: {
    tableName: "fin_venues" | "fin_venue_fields";
    rowId: number;
    changedBy: string;
    after: Record<string, unknown> | null;
    note: string;
  },
): Promise<boolean> {
  try {
    const { error } = await sb.from("fin_change_log").insert({
      table_name: entry.tableName,
      row_id: entry.rowId,
      action: "insert",
      changed_by: entry.changedBy,
      before_json: null, // an assignment always CREATES a link; there is no prior row
      after_json: entry.after,
      note: entry.note,
    });
    if (error) throw new Error(error.message);
    return true;
  } catch (e) {
    console.error("fin_change_log insert failed (write already applied):", e);
    return false;
  }
}

export async function POST(req: Request) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const fieldId = Number(body?.fieldId);
  if (!Number.isInteger(fieldId)) return Response.json({ error: "fieldId required" }, { status: 400 });

  // THE SERVER RE-DERIVES EVERYTHING. The client's row, its venue list and its
  // preview are claims. The mapping half of the payload is never cached, so
  // "already mapped" is decided against the database as it is right now.
  let payload;
  try {
    payload = await fieldsPayload(auth.supabase, await fieldAggregate(auth.supabase));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
  const row = payload.fields.find((f) => f.fieldId === fieldId) ?? null;

  const check = validateAssignment(
    {
      fieldId,
      mode: String(body?.mode ?? ""),
      venueId: body?.venueId as number | null | undefined,
      venueName: body?.venueName as string | null | undefined,
      city: body?.city as string | null | undefined,
      billingType: body?.billingType as string | null | undefined,
      countsAsRegularPlay: body?.countsAsRegularPlay,
    },
    { row, venues: payload.venues },
  );
  if (!check.ok) return Response.json({ error: check.error }, { status: 409 });
  const request: AssignRequest = check.request;
  const actor = auth.email;

  // ── the write ────────────────────────────────────────────────────────────
  // ONE ATTEMPT, NO RETRY. mdapi_field_id is UNIQUE, so a concurrent assignment
  // of the same field loses at the database rather than producing a second link.
  let venueId: number | null = request.mode === "existing" ? request.venueId : null;
  let createdVenueRow: Record<string, unknown> | null = null;
  let linkRow: Record<string, unknown> | null = null;
  let writeErr: string | null = null;

  const targetName =
    request.mode === "existing"
      ? payload.venues.find((v) => v.id === request.venueId)?.venueName ?? `#${request.venueId}`
      : request.venueName;

  const changes: Change[] = [
    { key: "mdapi_field_id", field: "Field ID", before: "—", after: fieldId },
    { key: "fin_venue_id", field: "Venue", before: "UNMAPPED", after: targetName },
    { key: "field_title_at_link", field: "Title at link", before: "—", after: request.titleAtLink ?? "—" },
    { key: "counts_as_regular_play", field: "Counts as regular play", before: "—", after: request.countsAsRegularPlay },
  ];
  if (request.mode === "new") {
    changes.push(
      { key: "venue_name", field: "New venue", before: "—", after: request.venueName },
      { key: "city", field: "City", before: "—", after: request.city },
      { key: "billing_type", field: "Billing type", before: "—", after: request.billingType },
      // Stated in the log, not only in a comment: a venue created here has NO rate.
      { key: "per_match_rate", field: "Rate", before: "—", after: "NULL — untracked, not free" },
    );
  }

  const { outcome, logged, error } = await recordWrite(
    {
      env: "production",
      source: "Admin · Fields · Assign",
      actorName: actor,
      actorEmail: actor,
      saveId: randomUUID(),
      matchId: null,
      matchName: null,
      method: "POST",
      path: `/fin_venue_fields/${fieldId}`,
      body: {
        mdapi_field_id: fieldId,
        mode: request.mode,
        venue: targetName,
        counts_as_regular_play: request.countsAsRegularPlay,
      },
      keys: ["link"],
      // `label` is unused here — `changes` is supplied explicitly below rather than
      // diffed out of a flat body, because an assignment is not a field edit.
      label: (k) => k,
      // APPLIED IS DECIDED BY THE READ-BACK, NOT BY THE INSERT'S RETURN. The link
      // must exist, point at the venue we meant, and carry the flag we sent. Any
      // one of those being wrong is NOT APPLIED, whatever status the insert gave.
      applied: (_before, after) => {
        const l = after.link as Record<string, unknown> | null | undefined;
        if (!l) return false;
        return venueId != null && Number(l.fin_venue_id) === venueId && l.counts_as_regular_play === request.countsAsRegularPlay;
      },
      changes,
    },
    {
      readResource: async () => {
        const r = await auth.supabase.from("fin_venue_fields").select(LINK_COLS).eq("mdapi_field_id", fieldId).maybeSingle();
        return { link: r.data ?? null };
      },
      write: async () => {
        if (request.mode === "new") {
          // NO RATE, DELIBERATELY (migration 0142). per_match_rate and
          // cost_per_match stay NULL: the pitch reports as UNTRACKED rather than
          // free, because a $0 rate claims the field costs nothing and NULL claims
          // we do not know yet — and only one of those is true.
          const v = await auth.supabase
            .from("fin_venues")
            .insert({
              venue_name: request.venueName,
              city: request.city,
              billing_type: request.billingType,
              per_match_rate: null,
              cost_per_match: null,
              is_active: true,
            })
            .select(VENUE_COLS)
            .single();
          if (v.error) { writeErr = v.error.message; throw new Error(v.error.message); }
          createdVenueRow = v.data as Record<string, unknown>;
          venueId = Number((v.data as { id: number }).id);
        }
        const l = await auth.supabase
          .from("fin_venue_fields")
          .insert({
            fin_venue_id: venueId,
            mdapi_field_id: fieldId,
            field_title_at_link: request.titleAtLink,
            counts_as_regular_play: request.countsAsRegularPlay,
          })
          .select(LINK_COLS)
          .single();
        if (l.error) { writeErr = l.error.message; throw new Error(l.error.message); }
        linkRow = l.data as Record<string, unknown>;
        return l.data;
      },
      now: () => new Date().toISOString(),
    },
    supabaseLogStore(),
  );

  if (writeErr || error) {
    const msg = writeErr ?? error?.message ?? "Assignment failed.";
    // The UNIQUE on mdapi_field_id is the race guard. Name it rather than leaking
    // a constraint string at the operator.
    const friendly = /duplicate key|unique/i.test(msg)
      ? `Field ${fieldId} was mapped by someone else while this dialog was open. Reload and look at where it points now.`
      : msg;
    return Response.json({ error: friendly, outcome, logRecorded: logged }, { status: 409 });
  }

  // ── the second log ───────────────────────────────────────────────────────
  // fin_change_log, AFTER the write and after change_log. Best-effort, reported.
  // See the header: this is the fin_venue_fields history, not a duplicate of the
  // verdict above. DO NOT DELETE ONE OF THESE.
  const note =
    request.mode === "new"
      ? `Admin · Fields — field ${fieldId} "${request.titleAtLink ?? "untitled"}" assigned to NEW venue "${request.venueName}" (${request.city}); no rate set (UNTRACKED)`
      : `Admin · Fields — field ${fieldId} "${request.titleAtLink ?? "untitled"}" assigned to "${targetName}"`;
  let finLogged = true;
  if (request.mode === "new" && venueId != null) {
    finLogged = (await finLog(auth.supabase, {
      tableName: "fin_venues", rowId: venueId, changedBy: actor, after: createdVenueRow, note,
    })) && finLogged;
  }
  finLogged = (await finLog(auth.supabase, {
    // row_id is the mdapi_field_id: fin_venue_fields has a composite key and no
    // surrogate id, and the counts_as_regular_play toggle already logs it this
    // way. Two writers, one convention.
    tableName: "fin_venue_fields", rowId: fieldId, changedBy: actor, after: linkRow, note,
  })) && finLogged;

  // The new link changes which venue's totals a field belongs to, and a new venue
  // is not in the cached aggregate's venue list at all.
  invalidateFieldAggregate();

  // Re-read from the database and recompute the preview against what LANDED, so the
  // operator sees the consequence as it actually is rather than as it was predicted.
  // A failed re-read does not undo anything — the write already happened.
  let after: { mapping: unknown; landed: unknown } | null = null;
  try {
    const fresh = await fieldsPayload(auth.supabase, await fieldAggregate(auth.supabase, true));
    const freshRow = fresh.fields.find((f) => f.fieldId === fieldId) ?? null;
    const freshVenue = fresh.venues.find((v) => v.id === venueId) ?? null;
    if (freshRow && freshVenue) {
      after = {
        mapping: freshRow.mapping,
        // The venue's totals now INCLUDE this field, so the preview is re-run
        // against the venue as it stood BEFORE — otherwise it would double-count.
        landed: previewAssignment(
          freshRow,
          {
            ...freshVenue,
            liveMatches: freshVenue.liveMatches - freshRow.liveMatches,
            dppRevenue: Math.round((freshVenue.dppRevenue - freshRow.dppRevenue) * 100) / 100,
          },
          freshRow.mapping?.countsAsRegularPlay === true,
        ),
      };
    }
  } catch {
    /* the write is what matters; a failed re-read is not a failed write */
  }

  return Response.json({
    ok: true,
    outcome,                   // LANDED / FAILED / NOT APPLIED / UNKNOWN, from the read-back
    logRecorded: logged,       // change_log — the verdict
    finLogRecorded: finLogged, // fin_change_log — the table's history
    venueId,
    link: linkRow,
    after,
  });
}

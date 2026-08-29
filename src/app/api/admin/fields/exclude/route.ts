/* POST /api/admin/fields/exclude — the ONLY write path for fin_venue_fields.excluded_from_venue.
 *
 *   { fieldId: number, excluded: boolean }  ->  { verdict, ... }
 *
 * WHAT IT DOES AND DELIBERATELY DOES NOT. It flips one boolean on one link row. It does not
 * unlink, does not re-point, does not touch counts_as_regular_play, and does not create or delete
 * anything. Unlink and re-point remain refused in validateAssignment and that guard stays: they
 * rewrite history irreversibly, and this replaces them for the purpose that asked.
 *
 * ONE UPDATE, WHERE ON mdapi_field_id. That column is `NOT NULL UNIQUE` (migration 0041:36), so
 * exactly one row can match and the statement is atomic by construction — there is no window in
 * which the field is half-changed. The WHERE also satisfies pg_safeupdate, which rejects an
 * unqualified UPDATE.
 *
 * ── TWO LOGS, AND NEITHER IS REDUNDANT ────────────────────────────────────────────────────────
 * The same split the assign route documents at length:
 *   change_log      THE VERDICT — recordWrite reads the row before, writes, reads it back and
 *                   classifies from what it finds. A 2xx does not mean the write landed.
 *   fin_change_log  THE TABLE'S HISTORY — migration 0130 widened its CHECK allowlist to accept
 *                   fin_venue_fields, and counts_as_regular_play already writes there. Every
 *                   change to a fin_venue_fields row belongs in one place and this is it.
 *
 * AND THE fin_change_log ROW SAYS WHICH VENUE. row_id is an integer and fin_venue_fields has no
 * surrogate id, so the existing convention stores the FIELD id there. On its own that cannot say
 * which venue a field stopped counting toward, so before_json/after_json carry fin_venue_id and
 * the flag on both sides. An audit that records "something changed" is not an audit.
 *
 * NO CONFIRMATION, BY RULING, and the reason is a property of the write: it is reversible, it is
 * visible on the row, and nothing is destroyed. A confirm on every click is what makes a list of
 * 48 unusable. The consequence is shown inline on the toggle instead.
 *
 * NO RETRIES. One UPDATE. A failed flip leaves the row exactly as it was — which is the other
 * half of why this is safe to offer without ceremony.
 */

import { randomUUID } from "node:crypto";
import { authenticateAdmin } from "@/lib/adminAuth";
import { recordWrite, supabaseLogStore } from "@/lib/changeLog";
import { invalidateFieldAggregate } from "@/lib/fieldIdAdminServer";
import { isExcludedLink } from "@/lib/venueLinkFilter";
import type { SupabaseClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type LinkRow = {
  fin_venue_id: number;
  mdapi_field_id: number;
  field_title_at_link: string | null;
  counts_as_regular_play: boolean;
  excluded_from_venue?: unknown;
};

/** Best-effort, and it NEVER throws over the write: the write already happened, and a logging
 *  outage must not turn a landed edit into an error the operator would retry. Returns whether it
 *  landed so the response can say so — a logging hole is loud, never silent. */
async function finLog(sb: SupabaseClient, entry: {
  rowId: number; changedBy: string; before: unknown; after: unknown; note: string;
}): Promise<boolean> {
  try {
    const { error } = await sb.from("fin_change_log").insert({
      table_name: "fin_venue_fields",
      row_id: entry.rowId,
      action: "update",
      changed_by: entry.changedBy,
      before_json: entry.before,
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

  const body = (await req.json().catch(() => null)) as { fieldId?: unknown; excluded?: unknown } | null;
  const fieldId = Number(body?.fieldId);
  /* STRICT BOOLEAN. A missing or non-boolean value is not a "no" and not a "yes" — it is a
   * malformed request, and this flag removes real money from a venue's figures. The string
   * "false" must never turn it on. */
  if (!Number.isInteger(fieldId) || fieldId <= 0) {
    return Response.json({ error: "A numeric fieldId is required." }, { status: 400 });
  }
  if (typeof body?.excluded !== "boolean") {
    return Response.json({ error: "`excluded` must be true or false." }, { status: 400 });
  }
  const next = body.excluded;

  const sb = auth.supabase;
  const read = async (): Promise<LinkRow | null> => {
    // select("*") — 0155 may not have applied yet on a fresh deploy; a named column would 400.
    const r = await sb.from("fin_venue_fields").select("*").eq("mdapi_field_id", fieldId).maybeSingle();
    if (r.error) throw new Error(r.error.message);
    return (r.data as LinkRow | null) ?? null;
  };

  let before: LinkRow | null;
  try { before = await read(); }
  catch (e) { return Response.json({ error: `Couldn't read the link: ${e instanceof Error ? e.message : String(e)}` }, { status: 502 }); }

  /* AN UNMAPPED FIELD HAS NOTHING TO EXCLUDE. Refused rather than silently no-op'd: a toggle that
   * appears to work on a field with no venue would be a lie about what the estate holds. */
  if (!before) {
    return Response.json({ error: `Field ${fieldId} is not on a venue, so there is nothing to exclude from.` }, { status: 400 });
  }
  const wasExcluded = isExcludedLink(before);
  if (wasExcluded === next) {
    // ALREADY THERE. Not an error and not a write — reported as landed because the desired state
    // is the actual state, and firing an UPDATE anyway would put a no-op in two audit tables.
    return Response.json({ verdict: "LANDED", noop: true, fieldId, excluded: next,
      venueId: before.fin_venue_id, logRecorded: null, finLogRecorded: null });
  }

  let updated: LinkRow | null = null;
  let writeErr: string | null = null;

  const { outcome, error, logged } = await recordWrite(
    {
      env: "production", source: "Venues & Fields · exclude toggle",
      actorName: auth.email, actorEmail: auth.email,
      saveId: randomUUID(), matchId: null, matchName: `Field ${fieldId}`,
      method: "PATCH", path: `fin_venue_fields?mdapi_field_id=eq.${fieldId}`,
      body: { mdapi_field_id: fieldId, fin_venue_id: before.fin_venue_id, excluded_from_venue: next },
      keys: [], label: (k) => k,
      changes: [{
        key: "excluded_from_venue",
        field: next ? "Excluded from venue" : "Counted toward venue",
        before: wasExcluded ? "excluded" : "counted",
        after: next ? "excluded" : "counted",
      }],
      // THE VERDICT IS THE READ-BACK, never the absence of an error.
      applied: (_b, a) => isExcludedLink((a as { link: LinkRow | null }).link) === next,
    },
    {
      readResource: async () => ({ link: await read() }),
      write: async () => {
        /* ONE UPDATE, ONE ROW, ATOMIC. mdapi_field_id is UNIQUE, so the WHERE matches exactly one
         * row; and .select() makes PostgREST return what it wrote, so zero rows is detectable
         * rather than silently "fine". */
        const r = await sb
          .from("fin_venue_fields")
          .update({ excluded_from_venue: next })
          .eq("mdapi_field_id", fieldId)
          .select("*")
          .maybeSingle();
        if (r.error) { writeErr = r.error.message; throw new Error(r.error.message); }
        if (!r.data) { writeErr = "the UPDATE matched no row"; throw new Error("the UPDATE matched no row"); }
        updated = r.data as LinkRow;
        return r.data;
      },
      now: () => new Date().toISOString(),
    },
    supabaseLogStore(),
  );

  if (error) {
    return Response.json({ verdict: "FAILED", fieldId, outcome, logRecorded: logged,
      error: writeErr ?? error.message }, { status: 502 });
  }

  const finLogged = await finLog(sb, {
    rowId: fieldId,
    changedBy: auth.email ?? "unknown",
    // BOTH SIDES CARRY THE VENUE. row_id is the field, so without this the row cannot say which
    // venue the field stopped counting toward.
    before: { mdapi_field_id: fieldId, fin_venue_id: before.fin_venue_id, excluded_from_venue: wasExcluded },
    after: { mdapi_field_id: fieldId, fin_venue_id: before.fin_venue_id, excluded_from_venue: next },
    note: next
      ? `Excluded field ${fieldId} from venue ${before.fin_venue_id}'s matches, spots, revenue and cost. Still linked.`
      : `Field ${fieldId} counts toward venue ${before.fin_venue_id} again.`,
  });

  // The cached mdapi aggregate does not hold the mapping, but the page re-reads through it; drop
  // the cache so the venue totals are right on the very next load rather than up to 10 minutes on.
  invalidateFieldAggregate();

  const landedState = isExcludedLink(updated);
  const verdict = outcome === "landed" && landedState === next ? "LANDED"
    : outcome === "landed" ? "NOT APPLIED"
    : outcome === "notapplied" ? "NOT APPLIED" : "UNKNOWN";

  /* `excluded` IS THE READ-BACK, NOT THE INTENT. Returning `next` would report what we asked
   * for, which is the same mistake as trusting a 2xx: the caller would render a sentence about a
   * state nobody observed. landedState is what the UPDATE's own .select() came back with, so a
   * verdict of LANDED and the state in the message can never disagree. */
  return Response.json({
    verdict, fieldId, excluded: landedState, venueId: before.fin_venue_id,
    outcome, logRecorded: logged, finLogRecorded: finLogged,
  });
}

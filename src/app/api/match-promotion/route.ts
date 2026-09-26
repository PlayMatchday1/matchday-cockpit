// GET  /api/match-promotion?week=YYYY-MM-DD — a week of matches joined to their promotion plan.
// POST /api/match-promotion                 — save one match's pushes, or mark one push sent.
//
// ONE ROUTE, TWO BODIES, NOT TWO ROUTES. A mark-sent is `{ pushId, pushed }`; a save is
// `{ matchApiId, pushes }`. Both go through the same capability check and the same fin_change_log
// audit, because a second write path for one boolean is a second place for the audit to be
// forgotten. Migration 0176.
//
// THE WRITE IS HERE AND NOWHERE ELSE. A client-side supabase write against a table with RLS returns
// 204 with error: null and changes nothing — indistinguishable from success. That has shipped four
// times in this app. match_promotion_plan is service-role-only precisely so a browser CANNOT write
// it, which makes this route the only path and makes a stray client call fail visibly.
//
// Reads mdapi_matches read-only. Reaches the MatchDay API nowhere.
import type { SupabaseClient } from "@supabase/supabase-js";
import { authenticateCapability } from "@/lib/capabilityAuth";
import { fetchPromoWeek, CHANNEL_KEYS, normalizePromoCode, type ChannelKey } from "@/lib/matchPromotion";
import { isTagKey } from "@/lib/promoTags";

export const runtime = "nodejs";
export const maxDuration = 30;

/** ?week=YYYY-MM-DD parsed as a LOCAL date so it lands in the intended week whatever the server tz. */
function weekRefFrom(url: string): Date {
  const raw = new URL(url).searchParams.get("week");
  const m = raw?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date();
}

export async function GET(req: Request) {
  const auth = await authenticateCapability(req, "matchops");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  try {
    const week = await fetchPromoWeek(auth.supabase, new Date(), weekRefFrom(req.url));
    return Response.json(week, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[api/match-promotion] GET failed", e);
    return Response.json({ error: "Failed to load the promotion week" }, { status: 500 });
  }
}

/** One push as the editor sends it. `id` present = an existing row; absent = a new one. */
type PushIn = {
  id?: number;
  channel?: string;
  /** ISO instant, or null = the channel is chosen and the time is not settled. */
  at?: string | null;
  topic?: string | null;
  promoCode?: string | null;
};

type SaveBody = {
  matchApiId?: number;
  /** THE WHOLE MATCH'S PUSHES, every channel. Rows not in this list are DELETED — that is what
   *  turning a channel off means, and it is why the client always sends the complete set. */
  pushes?: PushIn[];
  /* ── MARK SENT ────────────────────────────────────────────────────────────────────────────
   * Addressed to ONE push by id, never to a match. Marking one push of a match must leave its
   * siblings overdue. `pushed` is true to mark, false to un-mark. */
  pushId?: number;
  pushed?: boolean;
  /* ── A GENERAL PUSH ───────────────────────────────────────────────────────────────────────
   * Scoped to a CITY or a FIELD, belonging to no match. Same table as the match pushes, so the
   * queue and the tiles stay one projection of one set; see 0191 for why not two tables. */
  general?: {
    id?: number; scope?: "city" | "field"; channel?: string; at?: string | null;
    topic?: string | null; promoCode?: string | null; city?: string;
    fieldId?: number | null; audience?: string | null; remove?: boolean;
  };
  /* ── A FIELD TAG, TOGGLED ─────────────────────────────────────────────────────────────────
   * Keyed on the FIELD. `on` false removes it; the unique constraint makes the toggle safe. */
  tag?: { fieldId?: number; tag?: string; on?: boolean };
};

/** "" and whitespace collapse to NULL. An empty string is not a value, it is a cleared field. */
const nullable = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
};

/** The audit, through the finance recorder's own table and columns. Migration 0176 widens
 *  fin_change_log's table_name CHECK to accept match_promotion_push — the third time that
 *  allowlist has had to be widened, and the failure is loud rather than silent. */
type LogRow = { row_id: number; action: "insert" | "update" | "delete"; before: unknown; after: unknown };
async function recordPushes(
  sb: SupabaseClient, email: string | null, rows: LogRow[], note: string,
): Promise<string> {
  if (rows.length === 0) return "nothing to record";
  const { error } = await sb.from("fin_change_log").insert(rows.map((r) => ({
    table_name: "match_promotion_push",
    row_id: r.row_id,
    action: r.action,
    changed_by: email ?? "unknown",
    before_json: r.before ?? null,
    after_json: r.after ?? null,
    note,
  })));
  return error ? `not recorded: ${error.message}` : "recorded";
}

/** The message that names the migration rather than leaving a 42P01 nobody can read. */
function missingTableError(msg: string): string | null {
  if (/match_promotion_push/.test(msg) && /does not exist|schema cache|relation/i.test(msg)) {
    return "match_promotion_push does not exist yet — apply migration 0176 before saving a plan.";
  }
  if (/fin_change_log_table_name_check/.test(msg)) {
    return "The audit allowlist does not accept match_promotion_push yet — apply migration 0176.";
  }
  return null;
}

export async function POST(req: Request) {
  const auth = await authenticateCapability(req, "matchops");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  let body: SaveBody;
  try { body = (await req.json()) as SaveBody; }
  catch { return Response.json({ outcome: "FAILED", error: "Body is not JSON — nothing written." }, { status: 400 }); }

  /* ── BRANCH ONE: MARK ONE PUSH SENT ───────────────────────────────────────────────────────── */
  if (typeof body.pushed === "boolean") return markSent(auth, body);

  /* ── BRANCH 1b: A FIELD TAG ───────────────────────────────────────────────────────────────── */
  if (body.tag) return saveTag(auth, body.tag);

  /* ── BRANCH 1c: A GENERAL PUSH ────────────────────────────────────────────────────────────── */
  if (body.general) return saveGeneral(auth, body.general);

  const id = Number(body.matchApiId);
  if (!Number.isInteger(id) || id <= 0) {
    return Response.json({ outcome: "FAILED", error: "matchApiId is required." }, { status: 400 });
  }

  /* ── BRANCH TWO: SAVE THIS MATCH'S PUSHES ─────────────────────────────────────────────────
   * A FULL REPLACE, SCOPED TO ONE MATCH. The client sends every push for every channel; rows that
   * are no longer in the list are deleted, which is exactly what turning a channel off means.
   *
   * IDS SURVIVE THE REPLACE. A row that is edited keeps its id, so its pushed_at survives too —
   * delete-all-and-reinsert would un-send every push on the match every time somebody fixed a
   * typo in a topic. */
  /* ── A BODY WITH NO `pushes` KEY IS A STALE TAB, AND IT IS REFUSED ────────────────────────
   * AN EMPTY ARRAY AND A MISSING FIELD ARE NOT THE SAME THING. `pushes: []` is a real request —
   * every channel turned off — and it deletes this match's rows. `pushes` ABSENT is a browser
   * still running the pre-0176 bundle, posting { channels, pushAt, promoCode }; treated as an
   * empty replace it would wipe every push on the match, and the person would watch their own
   * Save do it. Nobody can hold a tab open across a deploy safely otherwise. */
  if (!Array.isArray(body.pushes)) {
    return Response.json({
      outcome: "FAILED",
      error: "This page is out of date. Reload it and make the change again. Nothing was written.",
    }, { status: 409 });
  }
  const incoming = body.pushes;
  const parsed: { id: number | null; channel: ChannelKey; push_at: string | null; topic: string | null; promo_code: string | null }[] = [];
  for (const raw of incoming) {
    const channel = String(raw?.channel ?? "");
    if (!(CHANNEL_KEYS as readonly string[]).includes(channel)) {
      return Response.json({ outcome: "FAILED", error: `Unknown channel "${channel}" — nothing written.` }, { status: 400 });
    }
    // push_at null is a REAL VALUE: the channel is chosen and the time is not settled. An empty
    // string must land as NULL and never as "".
    let at: string | null = null;
    if (typeof raw.at === "string" && raw.at.trim() !== "") {
      const t = new Date(raw.at);
      if (Number.isNaN(t.getTime())) {
        return Response.json({ outcome: "FAILED", error: "A push time is not a date — nothing written." }, { status: 400 });
      }
      at = t.toISOString();
    }
    const rid = Number(raw.id);
    parsed.push({
      id: Number.isInteger(rid) && rid > 0 ? rid : null,
      channel: channel as ChannelKey,
      push_at: at,
      topic: nullable(raw.topic),
      /* NORMALISED AT ENTRY, NOT GENERATED. Measured on production: 6,514 codes, 83
       * case-insensitive collisions and 486 mixing case. Upper-casing and stripping whitespace
       * kills that class going forward. Generating instead would be worse, not better: a promo
       * code only works if it exists in MatchDay, and this planner does not create them, so a
       * generated string would render on the tile, go to players and redeem nothing. */
      promo_code: normalizePromoCode(raw.promoCode ?? null),
    });
  }

  /* ── THE ONE COLLISION THAT BREAKS ATTRIBUTION, REFUSED ─────────────────────────────────────
   * The same code on two channels of one match makes every redemption attributable to both, which
   * is precisely the thing per-channel codes exist to fix. Refused here rather than warned about,
   * because a warning on a page this busy is a warning nobody reads.
   *
   * TWO DIFFERENT MATCHES SHARING A CODE IS NOT REFUSED. Campaigns legitimately run one code
   * across a week, and that is a different question from which channel a redemption came through. */
  const byCode = new Map<string, Set<string>>();
  for (const row of parsed) {
    if (!row.promo_code) continue;
    const set = byCode.get(row.promo_code) ?? new Set<string>();
    set.add(row.channel);
    byCode.set(row.promo_code, set);
  }
  for (const [code, channels] of byCode) {
    if (channels.size > 1) {
      return Response.json({
        outcome: "FAILED",
        error: `${code} is on ${[...channels].join(" and ")}. A code shared across channels cannot be `
          + `attributed to either, which is the whole reason it is per channel. Give each its own code, `
          + `or clear one. Nothing was written.`,
      }, { status: 400 });
    }
  }

  const sb = auth.supabase;
  const stamp = { updated_by: auth.email ?? null, updated_at: new Date().toISOString() };
  try {
    // BEFORE, for the audit. Read first so a change can be reconstructed from the log alone.
    const { data: before, error: readErr } = await sb
      .from("match_promotion_push").select("*").eq("match_api_id", id);
    if (readErr) {
      const named = missingTableError(readErr.message);
      return Response.json({ outcome: "FAILED", error: named ?? readErr.message }, { status: named ? 503 : 500 });
    }
    const existing = new Map((before ?? []).map((r) => [r.id as number, r]));

    /* AN ID THAT IS NOT THIS MATCH'S IS REFUSED, not silently re-parented. The editor never sends
     * one; a confused retry or a stale tab could. */
    for (const p of parsed) {
      if (p.id != null && !existing.has(p.id)) {
        return Response.json({
          outcome: "FAILED",
          error: "A push in this save belongs to a different match, or was removed by someone else. Reload and try again.",
        }, { status: 409 });
      }
    }

    const log: LogRow[] = [];

    // 1. UPDATE the rows that survive. pushed_at and pushed_by are NOT touched here: editing a
    //    push is not un-sending it.
    for (const p of parsed) {
      if (p.id == null) continue;
      const wasRow = existing.get(p.id)!;
      const same = (wasRow.push_at ?? null) === p.push_at && (wasRow.topic ?? null) === p.topic
        && (wasRow.promo_code ?? null) === p.promo_code && wasRow.channel === p.channel;
      if (same) continue;
      const { data: after, error } = await sb.from("match_promotion_push")
        .update({ channel: p.channel, push_at: p.push_at, topic: p.topic, promo_code: p.promo_code, ...stamp })
        .eq("id", p.id).select("*").maybeSingle();
      if (error) {
        const named = missingTableError(error.message);
        return Response.json({ outcome: "FAILED", error: named ?? error.message }, { status: named ? 503 : 500 });
      }
      log.push({ row_id: p.id, action: "update", before: wasRow, after });
    }

    // 2. INSERT the new ones.
    const fresh = parsed.filter((p) => p.id == null);
    if (fresh.length > 0) {
      const { data: added, error } = await sb.from("match_promotion_push")
        .insert(fresh.map((p) => ({
          match_api_id: id, channel: p.channel, push_at: p.push_at,
          topic: p.topic, promo_code: p.promo_code, ...stamp,
        })))
        .select("*");
      if (error) {
        const named = missingTableError(error.message);
        return Response.json({ outcome: "FAILED", error: named ?? error.message }, { status: named ? 503 : 500 });
      }
      for (const r of added ?? []) log.push({ row_id: r.id, action: "insert", before: null, after: r });
    }

    // 3. DELETE what is gone. THIS is what turning a channel off does, and it is why the client
    //    always sends the complete set rather than a diff.
    const keep = new Set(parsed.map((p) => p.id).filter((x): x is number => x != null));
    const gone = (before ?? []).filter((r) => !keep.has(r.id as number));
    if (gone.length > 0) {
      const { error } = await sb.from("match_promotion_push").delete().in("id", gone.map((r) => r.id));
      if (error) return Response.json({ outcome: "FAILED", error: error.message }, { status: 500 });
      for (const r of gone) log.push({ row_id: r.id as number, action: "delete", before: r, after: null });
    }

    /* THE PARENT ROW, FOR WHO LAST TOUCHED THIS MATCH. Its six booleans, push_at, promo_code,
     * pushed_at and pushed_by are inert from 0176 and are NOT written: a column nothing reads and
     * something still writes is the drift this migration exists to end. */
    await sb.from("match_promotion_plan")
      .upsert({ match_api_id: id, ...stamp }, { onConflict: "match_api_id" });

    // READ BACK from a fresh query, not from the writes' own echoes.
    const { data: back } = await sb.from("match_promotion_push").select("*").eq("match_api_id", id);
    const rows = back ?? [];
    if (rows.length !== parsed.length) {
      return Response.json({
        outcome: "NOT APPLIED",
        error: `The save reported success but ${rows.length} pushes read back where ${parsed.length} were sent. Nothing was retried.`,
      }, { status: 409 });
    }

    const audit = await recordPushes(sb, auth.email ?? null, log, "match promotion push saved");
    return Response.json({ outcome: "LANDED", pushes: rows, audit }, { status: 200 });
  } catch (e) {
    console.error("[api/match-promotion] POST failed", e);
    return Response.json({ outcome: "FAILED", error: "Nothing was written." }, { status: 500 });
  }
}

/**
 * MARK ONE PUSH SENT, OR UN-MARK IT.
 *
 * ADDRESSED TO A PUSH, NOT A MATCH. A match with three pushes has three independent sent states:
 * marking the WhatsApp one must leave the Klaviyo one overdue, which is the whole reason 0176 moved
 * the stamp down onto the child row.
 *
 * pushed_by IS A HUMAN SAYING IT HAPPENED, not the system observing it. It takes the same identity
 * updated_by takes, through the same route and the same fin_change_log audit.
 */
async function markSent(
  auth: { supabase: SupabaseClient; email?: string | null },
  body: SaveBody,
): Promise<Response> {
  const pushId = Number(body.pushId);
  if (!Number.isInteger(pushId) || pushId <= 0) {
    return Response.json({ outcome: "FAILED", error: "pushId is required to mark a push sent." }, { status: 400 });
  }
  const sb = auth.supabase;
  try {
    const { data: before, error: readErr } = await sb
      .from("match_promotion_push").select("*").eq("id", pushId).maybeSingle();
    if (readErr) {
      const named = missingTableError(readErr.message);
      return Response.json({ outcome: "FAILED", error: named ?? readErr.message }, { status: named ? 503 : 500 });
    }
    if (!before) {
      return Response.json({ outcome: "NOT APPLIED", error: "That push no longer exists. Reload the week." }, { status: 409 });
    }

    /* A PUSH WITH NO push_at CANNOT BE MARKED SENT. 0128 is explicit that NULL means "needs a
     * decision", which is not "done", and a sent stamp must not blur the two: there is nothing to
     * have sent. The UI renders no control at all; this refuses it anyway, because a UI check is
     * not a rule. */
    if (body.pushed === true && (before.push_at ?? null) === null) {
      return Response.json({
        outcome: "FAILED",
        error: "This push has no time yet, so there is nothing to mark sent. Set a date first.",
      }, { status: 400 });
    }

    const { data: after, error } = await sb.from("match_promotion_push")
      .update({
        pushed_at: body.pushed ? new Date().toISOString() : null,
        pushed_by: body.pushed ? auth.email ?? null : null,
        updated_by: auth.email ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", pushId).select("*").maybeSingle();
    if (error) {
      const named = missingTableError(error.message);
      return Response.json({ outcome: "FAILED", error: named ?? error.message }, { status: named ? 503 : 500 });
    }
    if (!after || (!!after.pushed_at) !== body.pushed) {
      return Response.json({
        outcome: "NOT APPLIED",
        error: "The mark reported success but read back different. Nothing was retried.",
      }, { status: 409 });
    }

    const audit = await recordPushes(sb, auth.email ?? null, [{ row_id: pushId, action: "update", before, after }],
      body.pushed ? "push marked sent" : "push un-marked");
    return Response.json({ outcome: "LANDED", push: after, audit }, { status: 200 });
  } catch (e) {
    console.error("[api/match-promotion] markSent failed", e);
    return Response.json({ outcome: "FAILED", error: "Nothing was written." }, { status: 500 });
  }
}

/* ── A FIELD TAG, TOGGLED ────────────────────────────────────────────────────────────────────
 * Keyed on the FIELD, so a pitch reads the same on every tile it appears on. The unique
 * constraint from 0190 is what makes the toggle safe: two operators pressing PARTNER at once
 * cannot produce two rows, and the second insert simply reports the conflict. */
async function saveTag(
  auth: { supabase: SupabaseClient; email?: string | null },
  t: NonNullable<SaveBody["tag"]>,
): Promise<Response> {
  const fieldId = Number(t.fieldId);
  if (!Number.isInteger(fieldId) || fieldId <= 0) {
    return Response.json({ outcome: "FAILED", error: "A tag needs a field." }, { status: 400 });
  }
  if (!isTagKey(t.tag)) {
    return Response.json({ outcome: "FAILED", error: `Unknown tag ${JSON.stringify(t.tag)} - nothing written.` }, { status: 400 });
  }
  const sb = auth.supabase;
  try {
    if (t.on === false) {
      const { error } = await sb.from("match_promotion_field_tag").delete().eq("field_id", fieldId).eq("tag", t.tag);
      if (error) {
        const named = missingTableError(error.message);
        return Response.json({ outcome: "FAILED", error: named ?? error.message }, { status: named ? 503 : 500 });
      }
      return Response.json({ outcome: "LANDED", fieldId, tag: t.tag, on: false });
    }
    /* UPSERT ON THE CONSTRAINT rather than select-then-insert. The read-then-write has a window
     * two operators can both pass through, and the failure is a duplicate nobody can see. */
    const { error } = await sb.from("match_promotion_field_tag")
      .upsert({ field_id: fieldId, tag: t.tag, set_by: auth.email ?? null }, { onConflict: "field_id,tag" });
    if (error) {
      const named = missingTableError(error.message);
      return Response.json({ outcome: "FAILED", error: named ?? error.message }, { status: named ? 503 : 500 });
    }
    return Response.json({ outcome: "LANDED", fieldId, tag: t.tag, on: true });
  } catch (e) {
    return Response.json({ outcome: "FAILED", error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

/* ── A GENERAL PUSH ──────────────────────────────────────────────────────────────────────────
 * Written into match_promotion_push with a scope, so the day queue reads ONE table and the tile's
 * coverage is a projection of the same rows. 0191's shape CHECK is the backstop: a malformed
 * combination is refused by the database rather than stored and reasoned about later. */
async function saveGeneral(
  auth: { supabase: SupabaseClient; email?: string | null },
  g: NonNullable<SaveBody["general"]>,
): Promise<Response> {
  const sb = auth.supabase;
  if (g.remove && Number.isInteger(Number(g.id))) {
    const { error } = await sb.from("match_promotion_push").delete().eq("id", Number(g.id)).neq("scope", "match");
    if (error) return Response.json({ outcome: "FAILED", error: error.message }, { status: 500 });
    return Response.json({ outcome: "LANDED", removed: Number(g.id) });
  }
  const scope = g.scope === "field" ? "field" : "city";
  const channel = String(g.channel ?? "");
  if (!(CHANNEL_KEYS as readonly string[]).includes(channel)) {
    return Response.json({ outcome: "FAILED", error: `Unknown channel ${JSON.stringify(channel)} - nothing written.` }, { status: 400 });
  }
  const city = String(g.city ?? "").trim();
  if (!city) return Response.json({ outcome: "FAILED", error: "A general push needs a city." }, { status: 400 });
  const fieldId = scope === "field" ? Number(g.fieldId) : null;
  if (scope === "field" && (!Number.isInteger(fieldId) || (fieldId as number) <= 0)) {
    return Response.json({ outcome: "FAILED", error: "A field push needs a field." }, { status: 400 });
  }
  /* AN UNDATED GENERAL PUSH COVERS NOTHING, and the page says so rather than silently covering the
   * whole week. It is still a legal row - the channel is chosen and the time is not settled, which
   * is 0176's own state - so it is stored and simply carries no coverage until it has a date. */
  let at: string | null = null;
  if (typeof g.at === "string" && g.at.trim() !== "") {
    const t = new Date(g.at);
    if (Number.isNaN(t.getTime())) {
      return Response.json({ outcome: "FAILED", error: "The push time is not a date - nothing written." }, { status: 400 });
    }
    at = t.toISOString();
  }
  const row = {
    scope, channel, push_at: at, topic: nullable(g.topic),
    promo_code: normalizePromoCode(g.promoCode ?? null),
    scope_city: city, scope_field_id: fieldId, audience: nullable(g.audience),
    match_api_id: null,
    updated_by: auth.email ?? null, updated_at: new Date().toISOString(),
  };
  try {
    const res = Number.isInteger(Number(g.id)) && Number(g.id) > 0
      ? await sb.from("match_promotion_push").update(row).eq("id", Number(g.id)).neq("scope", "match").select("id").maybeSingle()
      : await sb.from("match_promotion_push").insert(row).select("id").maybeSingle();
    if (res.error) {
      const named = missingTableError(res.error.message);
      return Response.json({ outcome: "FAILED", error: named ?? res.error.message }, { status: named ? 503 : 500 });
    }
    return Response.json({ outcome: "LANDED", id: res.data?.id ?? null });
  } catch (e) {
    return Response.json({ outcome: "FAILED", error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

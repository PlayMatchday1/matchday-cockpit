// GET  /api/match-promotion?week=YYYY-MM-DD — a week of matches joined to their promotion plan.
// POST /api/match-promotion                 — save one match's plan.
//
// THE WRITE IS HERE AND NOWHERE ELSE. A client-side supabase write against a table with RLS returns
// 204 with error: null and changes nothing — indistinguishable from success. That has shipped four
// times in this app. match_promotion_plan is service-role-only precisely so a browser CANNOT write
// it, which makes this route the only path and makes a stray client call fail visibly.
//
// Reads mdapi_matches read-only. Reaches the MatchDay API nowhere.
import { authenticateCapability } from "@/lib/capabilityAuth";
import { fetchPromoWeek, CHANNEL_KEYS, type ChannelKey } from "@/lib/matchPromotion";

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

type SaveBody = {
  matchApiId?: number;
  channels?: Partial<Record<ChannelKey, boolean>>;
  pushAt?: string | null;
  promoCode?: string | null;
  comment?: string | null;
};

/** "" and whitespace collapse to NULL. An empty string is not a value, it is a cleared field. */
const nullable = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
};

export async function POST(req: Request) {
  const auth = await authenticateCapability(req, "matchops");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  let body: SaveBody;
  try { body = (await req.json()) as SaveBody; }
  catch { return Response.json({ outcome: "FAILED", error: "Body is not JSON — nothing written." }, { status: 400 }); }

  const id = Number(body.matchApiId);
  if (!Number.isInteger(id) || id <= 0) {
    return Response.json({ outcome: "FAILED", error: "matchApiId is required." }, { status: 400 });
  }

  // push_at: an explicit null is a REAL VALUE here — "channels chosen, date not settled". It is not
  // the same as the field being absent, so an empty string must land as NULL and never as "".
  let pushAt: string | null = null;
  if (typeof body.pushAt === "string" && body.pushAt.trim() !== "") {
    const t = new Date(body.pushAt);
    if (Number.isNaN(t.getTime())) {
      return Response.json({ outcome: "FAILED", error: "pushAt is not a date — nothing written." }, { status: 400 });
    }
    pushAt = t.toISOString();
  }

  const row: Record<string, unknown> = {
    match_api_id: id,
    push_at: pushAt,
    promo_code: nullable(body.promoCode),
    comment: nullable(body.comment),
    updated_by: auth.email ?? null,
    updated_at: new Date().toISOString(),
  };
  for (const k of CHANNEL_KEYS) row[k] = body.channels?.[k] === true;

  const sb = auth.supabase;
  try {
    // BEFORE, for the audit. Read first so a change can be reconstructed from the log alone.
    const { data: before } = await sb.from("match_promotion_plan").select("*").eq("match_api_id", id).maybeSingle();

    const { data: written, error } = await sb
      .from("match_promotion_plan")
      .upsert(row, { onConflict: "match_api_id" })
      .select("*")
      .maybeSingle();

    // THE WRITE FAILS LOUDLY. The read degrades to "no plan" when the table is missing; the write
    // must never pretend. This is the message that tells Ryan the migration has not been applied.
    if (error) {
      const missing = /relation .* does not exist|schema cache/i.test(error.message);
      return Response.json({
        outcome: "FAILED",
        error: missing
          ? "match_promotion_plan does not exist yet — apply migration 0128 before saving a plan."
          : error.message,
      }, { status: missing ? 503 : 500 });
    }
    if (!written) {
      return Response.json({ outcome: "NOT APPLIED", error: "The write matched no rows." }, { status: 409 });
    }

    // READ BACK from a fresh query, not from the upsert's own echo, and check the fields that
    // decide what the tile says.
    const { data: back } = await sb.from("match_promotion_plan").select("*").eq("match_api_id", id).maybeSingle();
    const pushOk = (back?.push_at ?? null) === null ? pushAt === null : new Date(back!.push_at).toISOString() === pushAt;
    const chanOk = CHANNEL_KEYS.every((k) => (back?.[k] === true) === (row[k] === true));
    if (!back || !pushOk || !chanOk) {
      return Response.json({
        outcome: "NOT APPLIED",
        error: "The save reported success but the plan read back different. Nothing was retried.",
      }, { status: 409 });
    }

    // THE AUDIT, through the finance recorder's own table and columns. fin_change_log.table_name
    // carries a CHECK allowlist that migration 0128 widens to include this table; before it is
    // applied this insert fails, and the failure is reported rather than swallowed.
    const { error: logErr } = await sb.from("fin_change_log").insert({
      table_name: "match_promotion_plan",
      row_id: id,
      action: before ? "update" : "insert",
      changed_by: auth.email ?? "unknown",
      before_json: before ?? null,
      after_json: back,
      note: "match promotion plan saved",
    });

    return Response.json({
      outcome: "LANDED",
      plan: back,
      audit: logErr ? `not recorded: ${logErr.message}` : "recorded",
    }, { status: 200 });
  } catch (e) {
    console.error("[api/match-promotion] POST failed", e);
    return Response.json({ outcome: "FAILED", error: "Nothing was written." }, { status: 500 });
  }
}

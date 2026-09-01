// CREATE A MATCH — POST /api/matchday/{env}/matches/create
//
// STEP ONE OF TWO. Create takes NINE fields; the match editor edits twenty-one; only six overlap.
// So a copy cannot carry the source match's manager, prices, fake-spot schedule or auto-bump
// settings through this call — those go through the PUT that already works, as a second step. Two
// writes we both understand, rather than one write that cannot carry what a copy is for.
//
// THE DUPLICATE GUARD IS A QUERY, NOT A DISABLED BUTTON.
//
// There is no Idempotency-Key on this API and writes are never retried, and whether a double
// submit makes two matches is UNKNOWN — not "probably two". Measuring it would mean creating real
// matches on staging that DELETE /admin/matches/{id} (endpoint deny-list) could not clean up, and
// it would not change what gets built, because a disabled Save only stops a double CLICK. It does
// not stop a refresh mid-save, a second tab, or a retry at a layer below us.
//
// So this route ASKS FIRST: is there already a match at this fieldId and this startDate? If so it
// refuses and names the match, with its id, so the answer to the UNKNOWN stops mattering. An
// override is possible and must be explicit — never silent.
import { randomUUID } from "node:crypto";
import { authenticateCapability } from "@/lib/capabilityAuth";
import { apiGet, apiWrite, type MatchdayEnv } from "@/lib/matchdayStageApi";
import { insertMatchMirror } from "@/lib/mirrorWriteThrough";
import { EDITABLE_KEYS } from "@/lib/matchEditModel";
import { supabaseLogStore } from "@/lib/changeLog";
import { NO_EDIT_MATCHES } from "@/lib/matchEditAccess";
import { cityNameFor } from "@/lib/cityScope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const isEnv = (x: string): x is MatchdayEnv => x === "staging" || x === "production";

/** The nine the endpoint requires. Built explicitly — never spread from a source match. */
/* ── WHAT A COPY MAY SEND, AND WHAT IT MUST ──────────────────────────────────────────────────
 *
 * THESE WERE ONE LIST AND THAT IS HOW A MATCH WENT LIVE AT $0. CREATE_FIELDS was nine keys doing
 * double duty as "required" AND "allowed", so registrationPrice was not merely un-required — it
 * was REFUSED as `not creatable`. Production 18408 was copied on 2026-08-25, landed with no price,
 * and the API defaults an absent price to 0: 44 spots taken, 14 of them marked PAID with no
 * payment intent, against $15 siblings. All three copies ever made landed at 0 (18408, and staging
 * 2530/2531), so it was the button, not the match.
 *
 * REQUIRED is what the API itself demands — measured on staging 2026-08-31 by omitting them:
 * leaving out description and isFreeMember returns 400 "description must be a string",
 * "isFreeMember must be a boolean value".
 *
 * ALLOWED is now REQUIRED plus EDITABLE_KEYS — the exact set step two stages from the source. That
 * is the point: step one sends what step two would have staged, so step two becomes a confirmation
 * rather than a repair, and the price is right from the first millisecond.
 *
 * EVERY ONE OF THE 24 EDITABLE_KEYS IS ACCEPTED AND STORED. Measured on staging: one POST carrying
 * all of them came back with all 24 persisted verbatim, managerId included (a real id, 260, not
 * just an accepted null). NOTHING IS REFUSED — there is no constraint to list.
 *
 * teamNumbers is neither: it is write-only on the API (accepted on a write, absent from the GET),
 * which is why it sits in REQUIRED rather than in EDITABLE_KEYS.
 *
 * ── AND THERE IS NO PAUSED STATE TO FALL BACK ON ─────────────────────────────────────────────
 * Measured on staging 2026-08-31: a match object has no published / hidden / draft / visible /
 * active field of any kind — the only lifecycle flag is isCancelled, and this endpoint refuses it
 * outright: "property isCancelled should not exist". A created match is joinable from the first
 * millisecond, so there is no way to create it dark and release it on Save. That is why the body
 * being right AT CREATION is the whole of the safety, and why this list is the fix. */
const CREATE_REQUIRED = [
  "name", "description", "type", "startDate", "endDate",
  "fieldId", "maxPlayerCount", "teamNumbers", "isFreeMember",
] as const;

const CREATE_FIELDS = [
  ...CREATE_REQUIRED,
  ...EDITABLE_KEYS.filter((k) => !(CREATE_REQUIRED as readonly string[]).includes(k)),
] as const;

const MATCH_TYPES = new Set(["EVENT", "REGULAR", "BRACKET", "GROUP"]);

type Body = {
  match?: Record<string, unknown>;
  /** Deliberate override of the duplicate guard. Absent or false means the guard applies. */
  allowDuplicate?: boolean;
  source?: string;
  saveId?: string;
};

export async function POST(req: Request, ctx: { params: Promise<{ env: string }> }) {
  const auth = await authenticateCapability(req, "editMatches");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { env } = await ctx.params;
  if (!isEnv(env)) {
    return Response.json({ error: `unknown environment ${JSON.stringify(env)}` }, { status: 400 });
  }

  // THE SAME CAPABILITY AS EDITING, not a new one and not is_admin. Creating a match is editing
  // the schedule; inventing a right for it would mean a grant nobody has ticked.
  if (!auth.canEditMatches) {
    console.warn(`[edit-matches] 403: ${auth.email} attempted POST /admin/matches without EDIT MATCHES`);
    return Response.json({ error: NO_EDIT_MATCHES }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as Body | null;
  const match = body?.match;
  if (!match || typeof match !== "object" || Array.isArray(match)) {
    return Response.json({ error: "match object required" }, { status: 400 });
  }

  // ── VALIDATION, BEFORE ANY NETWORK CALL ─────────────────────────────────────────────────────
  // THE DATE IS NAMED SEPARATELY because it is the one field a copy deliberately arrives without.
  // "startDate is required" has to say WHICH field, or the form cannot point at it.
  /* REQUIRED, not ALLOWED. Checking the whole allowed set here would demand a managerId on every
   * copy — the nullable ones are optional by design and the API takes them as null. */
  const missing = CREATE_REQUIRED.filter((k) => match[k] === undefined || match[k] === null || match[k] === "");
  if (missing.includes("startDate") || missing.includes("endDate")) {
    return Response.json({
      error: "Pick a date and time for the copy — it is deliberately blank so a copy cannot arrive carrying the original's date.",
      field: missing.includes("startDate") ? "startDate" : "endDate",
    }, { status: 400 });
  }
  if (missing.length) {
    return Response.json({ error: `missing required field(s): ${missing.join(", ")}`, field: missing[0] }, { status: 400 });
  }
  const extra = Object.keys(match).filter((k) => !(CREATE_FIELDS as readonly string[]).includes(k));
  if (extra.length) {
    // The endpoint itself refuses these by name; refusing here too means the failure is ours and
    // legible rather than a 400 from somebody else's validator.
    return Response.json({ error: `not creatable: ${extra.join(", ")} — per-instance fields cannot be copied` }, { status: 400 });
  }
  if (!MATCH_TYPES.has(String(match.type))) {
    return Response.json({ error: `type must be one of ${[...MATCH_TYPES].join(", ")}`, field: "type" }, { status: 400 });
  }

  const fieldId = Number(match.fieldId);
  const startDate = String(match.startDate);

  try {
    /* ── THE CITY BOUNDARY, ON THE fieldId, FROM THE SERVER ──────────────────────────────────
     * A confined account may only create a match on a field in ITS OWN city. The city comes from
     * app_users.city_identifier via authenticateCapability — never from the request body, a query
     * param or a header, because all three are the caller's to write.
     *
     * THE DROPDOWN CONTRIBUTES NOTHING TO THIS DECISION. Filtering the select is a convenience; a
     * confined account can post any fieldId it likes and this is what refuses it. Until this
     * existed, create was the one route under /api/matchday/ with no city check at all — the
     * prefix allows the whole namespace, so every handler is reachable unless someone remembered.
     *
     * DENY BY DEFAULT ON A FAILED LOOKUP. If the field list cannot be read, `allowed` is empty and
     * the create is refused. A lookup failure must never widen the boundary.
     *
     * AN UNCONFINED ACCOUNT SKIPS THIS ENTIRELY — identical behaviour to before. */
    if (auth.confinedCity) {
      const cityName = cityNameFor(auth.confinedCity);
      const raw = await apiGet<unknown[]>(env, "/admin/fields").catch(() => []);
      const allowed = (Array.isArray(raw) ? raw : [])
        .map((f) => f as Record<string, unknown>)
        .filter((f) => (((f.city as Record<string, unknown> | undefined)?.name as string | undefined) ?? null) === cityName)
        .map((f) => Number(f.id));
      if (!allowed.includes(fieldId)) {
        console.warn(`[create-match] 403: ${auth.email} (confined to ${auth.confinedCity}) attempted fieldId ${fieldId}`);
        return Response.json({
          error: `Field ${fieldId} is not in ${cityName ?? auth.confinedCity}. This account can only create matches on its own city's fields.`,
          field: "fieldId",
        }, { status: 403 });
      }
    }

    // ── THE DUPLICATE GUARD ───────────────────────────────────────────────────────────────────
    // Asked of the API, not of our mirror: the mirror can be minutes behind, and a duplicate made
    // sixty seconds ago is exactly the one this is for. The window is the calendar DAY of the
    // requested start, which is the smallest window /admin/matches will filter on; the exact
    // instant is compared in JS afterwards.
    let duplicate: { id: number; name: string; startDate: string } | null = null;
    if (body?.allowDuplicate !== true) {
      const day = startDate.slice(0, 10);
      const res = await apiGet<{ data?: Record<string, unknown>[] }>(env, "/admin/matches", {
        fromDate: day, toDate: day, page: 1, limit: 100,
      });
      const rows = (Array.isArray(res) ? res : (res.data ?? [])) as Record<string, unknown>[];
      const hit = rows.find((m) => {
        const f = (m.field ?? {}) as Record<string, unknown>;
        const sameField = Number(f.id ?? m.fieldId) === fieldId;
        // WALL-CLOCK COMPARISON. startDate carries a "Z" it does not mean, so both sides are
        // compared as the strings the API stores — never through new Date(), which re-shifts.
        const sameStart = String(m.startDate ?? "").slice(0, 16) === startDate.slice(0, 16);
        return sameField && sameStart && m.isCancelled !== true;
      });
      if (hit) {
        duplicate = {
          id: Number(hit.id),
          name: String(hit.name ?? ""),
          startDate: String(hit.startDate ?? ""),
        };
        return Response.json({
          error: `A match already exists at this field and time: ${duplicate.id}`,
          duplicate,
          // The client offers the override; the server never assumes it.
          overridable: true,
        }, { status: 409 });
      }
    }

    // ── THE WRITE ─────────────────────────────────────────────────────────────────────────────
    const actor = { canEditMatches: auth.canEditMatches, email: auth.email, userId: auth.appUserId };
    /* ONLY WHAT WAS SUPPLIED. An absent optional stays absent rather than going over as an
     * explicit undefined — the diff IS the request body, here as everywhere. */
    const payload: Record<string, unknown> = {};
    for (const k of CREATE_FIELDS) if (k in match) payload[k] = match[k];

    const saveId = body?.saveId || randomUUID();
    let created: Record<string, unknown> | null = null;

    // A 2xx IS NOT PROOF. The response is used only for the id; the match is then READ BACK and
    // the outcome classified from what the API says exists, not from the status code.
    const wrote = await apiWrite<Record<string, unknown>>(env, "POST", "/admin/matches", payload, actor);
    const newId = Number((wrote as Record<string, unknown>)?.id ?? (wrote as Record<string, unknown>)?.matchId ?? 0);

    let outcome: "LANDED" | "FAILED" | "UNKNOWN" = "UNKNOWN";
    if (Number.isFinite(newId) && newId > 0) {
      try {
        created = await apiGet<Record<string, unknown>>(env, `/admin/matches/${newId}`);
        outcome = created && Number(created.id) === newId ? "LANDED" : "UNKNOWN";
      } catch {
        // The write may well have landed; the read-back is what failed. Never retried, never
        // assumed — UNKNOWN is the honest answer and the caller is told to verify by hand.
        outcome = "UNKNOWN";
      }
    }

    // ── THE AUDIT ENTRY ───────────────────────────────────────────────────────────────────────
    // recordWrite's shape is read-before/write/read-after, which a CREATE has no "before" for, so
    // the entry is written directly: the resource did not exist, and pretending to read it would
    // put a lie in the log. NO PHONE NUMBER AND NO MESSAGE BODY — the payload is nine schedule
    // fields and carries neither.
    let logged = false;
    try {
      const store = supabaseLogStore();
      await store.insert({
        saveId,
        at: new Date().toISOString(),
        env,
        source: body?.source || "Copy match",
        actorName: auth.email,
        actorEmail: auth.email,
        matchId: newId || null,
        matchName: String(payload.name ?? ""),
        method: "POST",
        endpoint: "/admin/matches",
        body: payload,
        outcome: outcome === "LANDED" ? "landed" : "unknown",
        serverSaid: newId ? `id ${newId}` : null,
        // A CREATE HAS NO "BEFORE" — the resource did not exist. Each field is recorded with a
        // null before rather than a fabricated one, because a log that invents a prior value is
        // worse than a log that admits there was none.
        changes: CREATE_FIELDS.map((k) => ({
          key: k as string, field: k as string, before: null, after: payload[k] ?? null,
        })),
      });
      logged = true;
    } catch (e) {
      console.error("[create-match] audit insert failed", e);
    }

    /* ── THE MIRROR ROW ───────────────────────────────────────────────────────────────────────
     * A created match has NO mdapi_matches row, so refreshMatchMirror's UPDATE would match zero
     * rows and report success over an empty mirror. Master Schedule reads that mirror, which is
     * why a match created from its own Copy button did not appear on the page that created it.
     *
     * Built from `created` — the same read-back the outcome above is classified from — through
     * the sync's own mapper. Production only, landed only, best-effort: the match exists in
     * MatchDay whatever happens here, so a mirror failure is reported and never turns a landed
     * create into a failure. */
    const mirror = created && outcome === "LANDED"
      ? await insertMatchMirror(auth.supabase, env, created, "landed")
      : { inserted: false, reason: outcome === "LANDED" ? "no read-back" : `outcome ${outcome}` };

    return Response.json({
      ok: outcome === "LANDED",
      outcome,
      id: newId || null,
      match: created,
      logRecorded: logged,
      saveId,
      mirrored: mirror.inserted,
      mirrorReason: mirror.reason ?? null,
    }, { status: outcome === "LANDED" ? 200 : 502 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ error: msg, outcome: "FAILED" }, { status: 502 });
  }
}

// HEROKU LOG DRAIN → app_request_log (0257). One URL per environment:
//   /api/drains/heroku/staging     ← matchday-stage
//   /api/drains/heroku/production  ← playmatchday (Ryan adds that drain himself)
// The PATH sets env. Nothing in the body can choose it.
//
// AUTH, in order (Ryan, 2026-11-06):
//   1. HTTP Basic, password = HEROKU_DRAIN_PASSWORD, compared in constant time. Unset = every
//      request refused (fail closed). Refused requests write nothing.
//   2. Logplex-Drain-Token must be the token pinned for this env (DRAIN_TOKENS below). The token is
//      an identifier Heroku assigns, not a secret: it pins WHICH drain may write each env. An
//      unpinned token is answered 2xx (so Heroku doesn't resend forever) and its whole batch is
//      dropped and counted, with the token recorded so it can be pinned.
//
// NEVER A 5xx FOR BAD INPUT. Malformed bodies, router lines, non-JSON and wrong-shape lines are
// dropped and counted. The one 503 is a failed ingest: the whole batch is ONE call to
// app_request_log_ingest() (0258), one transaction keyed on (env, Logplex-Frame-Id), so nothing of
// a failed batch lands and Heroku's resend (same frame id) applies it exactly once.
//
// WHAT IS STORED (0258, Ryan 2026-11-06): staff/webhook routes and lines with no user id go to an
// hourly route rollup; successful background requests to a per-player hourly rollup; the rest,
// including every failed request, to app_request_log. See splitLines.
//
// NO BODY IS EVER LOGGED HERE. The lines carry a player's id and IP; console output carries counts.

import { createHash, timingSafeEqual } from "node:crypto";
import { makeServerClient } from "@/lib/supabaseServer";
import { parseBody, type DropReason, type LogLine } from "@/lib/logplexDrain";
import { isAlwaysRow, isBackgroundRoute, isStaffKey, rollupRoute } from "@/lib/appActivity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Env = "staging" | "production";

// Pinned Logplex-Drain-Token per environment ("d." + uuid). Read from app_request_log_batches
// (drain_token on the unpinned rows) or `heroku drains --json | jq -r '.[].token'` — never print the
// url field, which may carry the password.
const DRAIN_TOKENS: Record<Env, readonly string[]> = {
  // matchday-stage, drain created 2026-11-06T21:02:20Z (heroku drains --json, token field only); the same
  // token arrived on the first unpinned batches in app_request_log_batches.
  staging: ["d.e188e63f-7a64-42d5-839d-d9298f7f011d"],
  // playmatchday, added by Ryan 2026-11-06 (token from him; the same token arrived on the first
  // unpinned production batches, 21:16:30Z on).
  production: ["d.4fda2caa-2724-45a9-bd13-17330ecb07bb"],
};

const EMPTY = () => new Response(null, { status: 200, headers: { "Content-Length": "0" } });
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest();

function passwordOk(header: string | null): boolean {
  const want = process.env.HEROKU_DRAIN_PASSWORD;
  if (!want || !header?.startsWith("Basic ")) return false;
  let decoded = "";
  try { decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8"); } catch { return false; }
  const colon = decoded.indexOf(":");
  if (colon < 0) return false;
  return timingSafeEqual(sha(decoded.slice(colon + 1)), sha(want));
}

export async function POST(req: Request, ctx: { params: Promise<{ env: string }> }) {
  const { env } = await ctx.params;
  if (env !== "staging" && env !== "production") return new Response(null, { status: 404, headers: { "Content-Length": "0" } });
  if (!passwordOk(req.headers.get("authorization"))) {
    return new Response(null, { status: 401, headers: { "Content-Length": "0", "WWW-Authenticate": 'Basic realm="drain"' } });
  }

  const frameId = req.headers.get("logplex-frame-id")?.slice(0, 200) ?? null;
  const token = req.headers.get("logplex-drain-token")?.slice(0, 200) ?? null;
  const msgCountRaw = Number(req.headers.get("logplex-msg-count"));
  const msgCount = Number.isSafeInteger(msgCountRaw) ? msgCountRaw : null;

  let sb;
  try { sb = makeServerClient(); } catch {
    console.error("[drain] supabase env missing");
    return new Response(null, { status: 503, headers: { "Content-Length": "0" } });
  }

  let parsed = 0;
  let dropped: Partial<Record<DropReason | "unpinned_drain_token", number>> = {};
  let lines: LogLine[] = [];
  try {
    const p = parseBody(Buffer.from(await req.arrayBuffer()));
    parsed = p.parsed;
    dropped = p.dropped;
    lines = p.lines;
  } catch (e) {
    // A body we could not even read. Counted, never a 5xx.
    console.warn(`[drain] ${env} unreadable body: ${(e as Error).name}`);
    dropped = { ...dropped, bad_frame: (dropped.bad_frame ?? 0) + 1 };
  }
  if (!token || !DRAIN_TOKENS[env].includes(token)) {
    // Whole batch dropped: every message, kept or not, is counted under the one reason.
    dropped = { unpinned_drain_token: parsed + (dropped.bad_frame ?? 0) };
    lines = [];
  }

  const s = splitLines(lines);
  const r = await sb.rpc("app_request_log_ingest", {
    p: {
      env, frame_id: frameId, drain_token: token, msg_count: msgCount, parsed, dropped,
      rows: s.rows, bg: s.bg, routes: s.routes,
      rolled_background: s.rolledBackground, rolled_anonymous: s.rolledAnonymous, rolled_staff: s.rolledStaff,
    },
  });
  if (r.error) {
    // One transaction: nothing of this batch landed. Heroku resends it with the same frame id.
    console.error(`[drain] ${env} ingest failed (${lines.length} lines): ${r.error.message}`);
    return new Response(null, { status: 503, headers: { "Content-Length": "0" } });
  }
  return EMPTY();
}

const toRow = (l: LogLine) => ({
  ts: l.ts, req_id: l.reqId, method: l.method, path: l.path, route: l.route, status: l.status,
  duration_ms: l.durationMs, user_id: l.userId, error_code: l.errorCode, ip: l.ip, match_id: l.matchId,
});

const hourOf = (iso: string) => { const d = new Date(iso); d.setUTCMinutes(0, 0, 0); return d.toISOString(); };

/** 0258's rules, in order: PUT /admin/user-matches is always a row (isAlwaysRow); staff/webhook → route rollup; no user id → route rollup; a background route that
 *  succeeded → the player's hourly rollup; everything else (every failure included) → a row. Each rollup array is
 *  aggregated so a key appears once per call (ON CONFLICT cannot update a row twice in one statement). */
function splitLines(lines: LogLine[]) {
  const rows: Record<string, unknown>[] = [];
  const bg = new Map<string, { user_id: number; hour: string; n: number; last_seen_at: string }>();
  const routes = new Map<string, { hour: string; kind: "staff" | "anonymous"; method: string; route: string; status: number; n: number }>();
  let rolledBackground = 0, rolledAnonymous = 0, rolledStaff = 0;
  for (const l of lines) {
    if (isAlwaysRow(l.method, l.route)) { rows.push(toRow(l)); continue; }
    const staff = isStaffKey(l.route, l.path);
    if (staff || l.userId == null) {
      const kind = staff ? "staff" : "anonymous";
      if (staff) rolledStaff++; else rolledAnonymous++;
      const hour = hourOf(l.ts), route = rollupRoute(l.route, l.path);
      const k = `${hour}|${kind}|${l.method}|${route}|${l.status}`;
      const cur = routes.get(k);
      if (cur) cur.n++; else routes.set(k, { hour, kind, method: l.method, route, status: l.status, n: 1 });
      continue;
    }
    if (l.status < 400 && isBackgroundRoute(l.method, l.route)) {
      rolledBackground++;
      const hour = hourOf(l.ts), k = `${l.userId}|${hour}`;
      const cur = bg.get(k);
      if (cur) { cur.n++; if (l.ts > cur.last_seen_at) cur.last_seen_at = l.ts; }
      else bg.set(k, { user_id: l.userId, hour, n: 1, last_seen_at: l.ts });
      continue;
    }
    rows.push(toRow(l));
  }
  return { rows, bg: [...bg.values()], routes: [...routes.values()], rolledBackground, rolledAnonymous, rolledStaff };
}

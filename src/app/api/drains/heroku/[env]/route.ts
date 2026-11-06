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
// dropped and counted in app_request_log_batches. The one 503 is a failed INSERT: Heroku then
// resends the same batch, and the unique (env, req_id) index makes the resend a no-op for the
// lines that did land.
//
// NO BODY IS EVER LOGGED HERE. The lines carry a player's id and IP; console output carries counts.

import { createHash, timingSafeEqual } from "node:crypto";
import { makeServerClient } from "@/lib/supabaseServer";
import { parseBody, type DropReason } from "@/lib/logplexDrain";

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

const CHUNK = 500;

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

  let parsed = 0, stored = 0;
  let dropped: Partial<Record<DropReason | "unpinned_drain_token", number>> = {};
  try {
    const body = Buffer.from(await req.arrayBuffer());
    const p = parseBody(body);
    parsed = p.parsed;
    dropped = p.dropped;

    if (!token || !DRAIN_TOKENS[env].includes(token)) {
      // Whole batch dropped: every message, kept or not, is counted under the one reason.
      dropped = { unpinned_drain_token: p.parsed + (p.dropped.bad_frame ?? 0) };
    } else {
      for (let i = 0; i < p.lines.length; i += CHUNK) {
        const rows = p.lines.slice(i, i + CHUNK).map((l) => ({
          env, ts: l.ts, req_id: l.reqId, method: l.method, path: l.path, route: l.route, status: l.status,
          duration_ms: l.durationMs, user_id: l.userId, error_code: l.errorCode, ip: l.ip, match_id: l.matchId,
        }));
        const ins = await sb.from("app_request_log")
          .upsert(rows, { onConflict: "env,req_id", ignoreDuplicates: true })
          .select("id");
        if (ins.error) {
          console.error(`[drain] ${env} insert failed after ${stored} stored: ${ins.error.message}`);
          await recordBatch(sb, { env, frameId, token, msgCount, parsed, stored, dropped: { ...dropped, insert_failed: p.lines.length - i } });
          return new Response(null, { status: 503, headers: { "Content-Length": "0" } });
        }
        stored += ins.data?.length ?? 0;
      }
    }
  } catch (e) {
    // A body we could not even read. Counted, never a 5xx.
    console.warn(`[drain] ${env} unreadable body: ${(e as Error).name}`);
    dropped = { ...dropped, bad_frame: (dropped.bad_frame ?? 0) + 1 };
  }

  await recordBatch(sb, { env, frameId, token, msgCount, parsed, stored, dropped });
  return EMPTY();
}

async function recordBatch(
  sb: ReturnType<typeof makeServerClient>,
  b: { env: Env; frameId: string | null; token: string | null; msgCount: number | null; parsed: number; stored: number; dropped: Record<string, number | undefined> },
) {
  const r = await sb.from("app_request_log_batches").insert({
    env: b.env, frame_id: b.frameId, drain_token: b.token, msg_count: b.msgCount, parsed: b.parsed, stored: b.stored, dropped: b.dropped,
  });
  if (r.error) console.warn(`[drain] ${b.env} batch record failed: ${r.error.message}`);
}

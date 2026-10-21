/* GET /api/lifecycle/acquisition/players?since=&until= — "Download players" (Ryan, 2026-10-21).
 *
 * A CSV of exactly the accounts the Registrations card counts for the range (lib/signupExport). The
 * row set is growth_account with the card's predicate, and the file is REFUSED (409) when its row
 * count differs from the card's sum over growth_acquisition_daily for the same range — the two read
 * the same view, and this makes a drift loud instead of a quietly different number.
 *
 * Admins only (lib/signupExport.playerExportGate); the E2E service account and confined accounts are
 * refused whatever their flags say. Every download is recorded in change_log: who, the range, the
 * row count. Never a player's data.
 *
 * BUILT FROM OUR COPY ONLY (Ryan, 2026-10-21, after the R15 outage). The first version looked every
 * row up live, GET /admin/players/{id}, 8 at a time, up to 5,000 a click — the bulk pattern the
 * no-bulk-reads rule names. mdapi_users is kept current by the 3 AM Central full pass, which also
 * re-reads the accounts the list stopped returning; a row it has not confirmed since the last complete
 * pass goes out with blank name, email and phone and Deleted "unknown" (lib/signupExport).
 * "Verified by" was dropped with the live read: emailVerifiedAt is on the detail payload only.
 */

import { randomUUID } from "node:crypto";
import { resolveSessionUser } from "@/lib/adminAuth";
import { isConfined } from "@/lib/cityConfinement";
import { selectAll } from "@/lib/supabasePagination";
import { recordWrite, supabaseLogStore } from "@/lib/changeLog";
import {
  buildSignupRows, inRange, playerExportGate, signupCsv, signupExportLogBody, signupFileName,
  textOptOuts, type ChatMsg, type ChatThread, type CountedAccount, type MirrorUser,
} from "@/lib/signupExport";

export const runtime = "nodejs";
export const maxDuration = 300;
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ROWS = 5000;
const PATH = "/api/lifecycle/acquisition/players";

const addDays = (ymd: string, n: number) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

export async function GET(req: Request) {
  const s = await resolveSessionUser(req);
  if (!s.ok) return Response.json({ error: s.error }, { status: s.status });
  if (isConfined(s.row)) return Response.json({ error: "Admin access required" }, { status: 403 });
  const gate = playerExportGate(s.row, s.email);
  if (!gate.ok) return Response.json({ error: gate.error }, { status: gate.status });

  const url = new URL(req.url);
  const q = (k: string) => { const v = url.searchParams.get(k); return v && YMD.test(v) ? v : null; };
  const since = q("since"), until = q("until");
  if (!since || !until || until < since) return Response.json({ error: "since and until (YYYY-MM-DD) are required" }, { status: 400 });

  try {
    const sb = s.supabase;
    // 1 — the card's number for the range
    const acq = await selectAll<{ signup_date: string; declared_city_raw: string | null; registrations: number }>(() =>
      sb.from("growth_acquisition_daily").select("signup_date, declared_city_raw, registrations").gte("signup_date", since).lte("signup_date", until).order("signup_date").order("declared_city_raw"));
    const cardCount = acq.reduce((a, r) => a + Number(r.registrations), 0);

    // 2 — the rows, from the same view with the same predicate. A UTC window a day wider on each
    // side, then the Chicago day decides (the view's own to_char … AT TIME ZONE 'America/Chicago').
    const wide = await selectAll<CountedAccount & { status: string }>(() =>
      sb.from("growth_account").select("account_id, status, completed_sign_up_at, declared_city_raw")
        .eq("status", "counted").not("completed_sign_up_at", "is", null)
        .gte("completed_sign_up_at", `${addDays(since, -1)}T00:00:00Z`).lt("completed_sign_up_at", `${addDays(until, 2)}T00:00:00Z`)
        .order("account_id"));
    const accounts = wide.filter((a) => inRange(a, since, until));
    if (accounts.length !== cardCount) {
      return Response.json({ error: `The file would have ${accounts.length} rows but the card shows ${cardCount}. Nothing was downloaded.` }, { status: 409 });
    }
    if (accounts.length > MAX_ROWS) {
      return Response.json({ error: `That range has ${accounts.length} players; the download is limited to ${MAX_ROWS}. Pick a shorter range.` }, { status: 413 });
    }

    // 3 — the mirror: every column the file carries about the player
    const ids = accounts.map((a) => a.account_id);
    const mirror = new Map<number, MirrorUser>();
    for (let i = 0; i < ids.length; i += 300) {
      const { data, error } = await sb.from("mdapi_users").select("id, email, first_name, last_name, phone_number, raw, synced_at").in("id", ids.slice(i, i + 300));
      if (error) throw new Error(`mdapi_users: ${error.message}`);
      for (const u of data ?? []) mirror.set(u.id as number, u as MirrorUser);
    }

    // 4 — which mirror rows the API has confirmed: those read since the last SUCCESSFUL full refresh
    // of mdapi_users started (fin_sync_log 'mdapi-users-full': the 3 AM pass since 2026-10-21, the
    // retired users-full route before it; the 'unlisted' re-read rows are not a full refresh). A row
    // read before it was not returned since. No live lookup (Ryan, 2026-10-21).
    const full = await sb.from("fin_sync_log").select("started_at").eq("source", "mdapi-users-full")
      .not("completed_at", "is", null).is("error_message", null).or("run_mode.is.null,run_mode.eq.full")
      .order("started_at", { ascending: false }).limit(1).maybeSingle<{ started_at: string }>();
    if (full.error) throw new Error(`fin_sync_log: ${full.error.message}`);
    const confirmedSince = full.data?.started_at ?? null;

    // 4b — STOP / START replies in Player Chats. Prefiltered by the keywords; the exact-word test is
    // textOptOuts' (so "stop by later" is not a stop).
    const kw = ["stop", "stopall", "unsubscribe", "end", "quit", "alto", "parar", "start", "unstop"];
    const inbound = await selectAll<ChatMsg>(() => sb.from("crm_messages").select("thread_id, body, sent_at").eq("direction", "inbound")
      .or(kw.map((w) => `body.ilike.${w}*`).join(",")).order("sent_at").order("id"));
    const tIds = [...new Set(inbound.map((m) => m.thread_id))];
    const threads: ChatThread[] = [];
    for (let i = 0; i < tIds.length; i += 300) {
      const { data, error } = await sb.from("crm_threads").select("id, phone_number, player_id").in("id", tIds.slice(i, i + 300));
      if (error) throw new Error(`crm_threads: ${error.message}`);
      threads.push(...((data ?? []) as ChatThread[]));
    }

    const rows = buildSignupRows(accounts, mirror, confirmedSince, textOptOuts(inbound, threads));
    const unconfirmed = rows.filter((r) => r.deleted === "unknown").length;
    const csv = signupCsv(rows);

    // 5 — the record: who, the range, the count. Never a player.
    const saveId = randomUUID();
    await recordWrite({
      env: "production", source: "Player export", actorName: s.email, actorEmail: s.email, saveId,
      matchId: null, matchName: null, method: "GET", path: PATH,
      body: signupExportLogBody(since, until, rows.length, unconfirmed), keys: [], label: (k) => k,
      applied: () => true,
      changes: [{ key: "download", field: "Download players", before: "", after: `${rows.length} players, ${since} to ${until}` }],
    }, { readResource: async () => ({}), write: async () => true, now: () => new Date().toISOString() }, supabaseLogStore());
    // An unrecorded download of player PII is not allowed to complete. The store's insert does not
    // surface a database error, so the row is read back: a recorded download is one we can read.
    const { data: rec, error: recErr } = await sb.from("change_log").select("id").eq("save_id", saveId).limit(1);
    if (recErr || !rec?.length) return Response.json({ error: "Couldn't record the download in the change log, so it was stopped." }, { status: 500 });

    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${signupFileName(since, until)}"`,
        "Cache-Control": "no-store",
        "X-Row-Count": String(rows.length),
        "X-Unconfirmed": String(unconfirmed),
      },
    });
  } catch (e) {
    console.error("[api/lifecycle/acquisition/players] failed", e instanceof Error ? e.message : e);
    return Response.json({ error: "Couldn't build the player file." }, { status: 500 });
  }
}

// Sync GET /admin/players → mdapi_users. Server-only.
//
// INCREMENTAL by default: newest→oldest by createdAt from page 1, stopping once a page reaches past
// (stored max created_at − 48h overlap). The overlap re-fetches a safe margin; upserts are
// idempotent (onConflict=id). No watermark (empty mirror) or forceFull → a FULL walk.
//
// PACED SINCE 2026-10-21 (the R15 outage): one request a second, no retries, stop at the first
// error — getPacedClient in matchdayApi.ts. A normal hourly run is ONE request.
//
// EDITS TO EXISTING ROWS — city, membership, signup completion, a deleted account's scrub — are not
// seen by the incremental walk. The daily 3 AM Central full pass (playerAreaSync.ts, runLeg) reads
// every player and upserts mdapi_users with mapRow from this file; that is where they arrive.
//
// TIMING, MEASURED 2026-08-25 (before pacing): a full run was 123 pages, 30,718 rows, 112.7s.
// Paced, a full run is at least one second a page (~146 pages on 2026-10-21) — a manual bootstrap
// only; the daily full read is the 3 AM pass.
//
// === Endpoint behavior (from probe, May 2026) ===
//   - totalItems IS reliable on this endpoint (unlike subscriptions
//     where it's broken). Use it to bound the page loop.
//   - sortColumn=createdAt + sortDirection=asc|desc both work.
//   - Pagination is 1-indexed. page=1, limit=250 returns rows 1..250.
//   - Response shape: { page, limit, totalItems, data[] }.
//   - 70% of newest users have null preferableCity AND null
//     completedSignUpAt (abandoned signup cohort) — both columns are
//     legitimately null, not a missing-data bug.
//
// We do NOT delete rows. If a user was deleted on MatchDay's side, we
// keep the last-known snapshot (raw column preserves it). The
// deletion rate is presumed low; if it becomes load-bearing we can
// add a soft-delete flag and a separate id-set diff step.
//
// Caller provides the Supabase client. Writes require service role
// (RLS allows authenticated SELECT only).

import type { SupabaseClient } from "@supabase/supabase-js";
import { getPacedClient, MatchdayApiError } from "./matchdayApi";
import { normalizeCityName } from "./cityNormalization";
import { withLogPatch, type LogPatch } from "./syncLogging";

const PAGE_LIMIT = 250;
// DB-side upsert chunk size. Initial Phase 1 setting of 500 hit
// Postgres statement_timeout at offset 16000 (table has 4 indexes +
// jsonb raw column → index maintenance scales fast per-statement).
// 100 is conservative; if this still times out drop to 50, if it's
// fast we can raise later. Don't pre-optimize — this is the
// minimum-blast-radius fix.
const UPSERT_BATCH = 100;
// How far back past the watermark an incremental walk re-fetches. The
// watermark is derived from data we already stored, so a margin absorbs
// clock skew, rows that landed mid-run on the previous sync, and the
// non-atomicity of paginated reads. 48h is generous and cheap (a few
// extra pages of idempotent re-upserts).
const WATERMARK_OVERLAP_MS = 48 * 60 * 60 * 1000;
export type ApiPlayer = {
  id?: number;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  phoneNumber?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  completedSignUpAt?: string | null;
  isFakePlayer?: boolean | null;
  isMember?: boolean | null;
  preferableCity?: { name?: string | null } | null;
};

type ApiPage = {
  page?: number;
  limit?: number;
  totalItems?: number;
  data?: ApiPlayer[];
};

export type DbRow = {
  id: number;
  email: string;
  first_name: string | null;
  last_name: string | null;
  phone_number: string | null;
  created_at: string;
  completed_sign_up_at: string | null;
  preferable_city_name: string | null;
  preferable_city_normalized: string | null;
  is_fake_player: boolean;
  is_member: boolean;
  raw: unknown;
  synced_at: string;
};

// Which API field (and matching DB column) the incremental walk keys on.
type WatermarkField = "updatedAt" | "createdAt";

type SyncMode = "full" | "incremental:updatedAt" | "incremental:createdAt";

export type MdapiUsersSyncResult = {
  mode: SyncMode;
  // ISO cutoff actually used (watermark − overlap), or null for a full run.
  watermark: string | null;
  totalItems: number;
  pagesFetched: number;
  rowsReceived: number;     // pre-dedupe (paginated total seen this run)
  upserted: number;
  rowsSkipped: number;      // rows missing required fields
  unmappedCities: string[]; // raw city names that didn't map (deduped)
  // How many rows in THIS run arrived already scrubbed by MatchDay ("Deleted"/"Account").
  // Only meaningful on a full run: an incremental walk never revisits an old row, which is
  // precisely why the full one exists. Not logged to fin_sync_log — there is no column for it and
  // borrowing one would make Recent Syncs lie about what it means.
  scrubbedSeen: number;
  apiCalls: number;
  durationMs: number;
};

// Surfaced in fin_sync_log (Recent Syncs) when the sync runs the
// less-complete createdAt fallback because /admin/players doesn't expose
// updatedAt. NOT a failure — the run completes and ok stays true — but
// it's logged so the degraded mode is never silent and is easy to grep.
export const MDAPI_USERS_CREATEDAT_FALLBACK_NOTE =
  "ADVISORY (sync OK): createdAt incremental — new signups are captured here; " +
  "edits to existing rows (membership, city, signup completion, deleted " +
  "accounts) arrive with the daily 3 AM Central full pass (/api/sync/player-areas).";

// Shared fin_sync_log patch for the mdapi-users step, used by both the
// cron orchestrator and the manual /api/sync/users route so the fallback
// advisory surfaces identically wherever the sync runs.
export function mdapiUsersLogPatch(r: MdapiUsersSyncResult): LogPatch {
  const base = { rows_imported: r.upserted, api_calls: r.apiCalls, run_mode: r.mode === "full" ? "full" : "incremental" };
  return r.mode === "incremental:createdAt"
    ? { ...base, error_message: MDAPI_USERS_CREATEDAT_FALLBACK_NOTE }
    : base;
}

export function mapRow(r: ApiPlayer, syncedAt: string, unmappedSet: Set<string>): DbRow | null {
  // Required: id, email, createdAt. Anything missing those is skipped —
  // we can't key the row or join on email.
  if (
    typeof r.id !== "number" ||
    typeof r.email !== "string" ||
    !r.email ||
    !r.createdAt
  ) {
    return null;
  }
  const rawCity = r.preferableCity?.name ?? null;
  const normalized = normalizeCityName(rawCity);
  if (rawCity && !normalized) {
    // normalizeCityName already console.warned; track for the summary.
    unmappedSet.add(rawCity.trim());
  }
  return {
    id: r.id,
    email: r.email,
    first_name: r.firstName ?? null,
    last_name: r.lastName ?? null,
    phone_number: r.phoneNumber ?? null,
    created_at: r.createdAt,
    completed_sign_up_at: r.completedSignUpAt ?? null,
    preferable_city_name: rawCity,
    preferable_city_normalized: normalized,
    is_fake_player: r.isFakePlayer === true,
    is_member: r.isMember === true,
    raw: r,
    synced_at: syncedAt,
  };
}

// Highest stored timestamp for the chosen watermark field, or null when
// nothing usable is stored yet (→ caller does a full sync). createdAt is
// an indexed column (migration 0020), so its max is a fast index probe.
// updatedAt is not a column — it would live only inside the raw jsonb —
// so this orders on the json path; that read is unindexed and can be slow
// or hit statement_timeout, in which case it THROWS and the caller demotes
// to createdAt. Today /admin/players does not expose updatedAt at all, so
// the updatedAt branch is dormant future-proofing.
async function readStoredMax(
  supabase: SupabaseClient,
  field: WatermarkField,
): Promise<number | null> {
  if (field === "createdAt") {
    const { data, error } = await supabase
      .from("mdapi_users")
      .select("created_at")
      .not("created_at", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle<{ created_at: string }>();
    if (error) throw new Error(error.message);
    const t = data?.created_at ? Date.parse(data.created_at) : NaN;
    return Number.isNaN(t) ? null : t;
  }
  const { data, error } = await supabase
    .from("mdapi_users")
    .select("mw:raw->>updatedAt")
    .not("raw->>updatedAt", "is", null)
    .order("raw->>updatedAt", { ascending: false })
    .limit(1)
    .maybeSingle<{ mw: string }>();
  if (error) throw new Error(error.message);
  const t = data?.mw ? Date.parse(data.mw) : NaN;
  return Number.isNaN(t) ? null : t;
}

/* A DELETION IS AN EDIT, AND NEITHER WATERMARK MODE CATCHES ONE.
 *
 * When a player deletes their account MatchDay does not remove the row — it SCRUBS IT IN PLACE and
 * keeps serving it from /admin/players (name "Deleted Account", phone null, email replaced by an
 * opaque token). The header below says "we do NOT delete rows… deletion rate is presumed low",
 * which aims at the wrong risk: nothing ever disappears, so no id-set diff is needed. What we miss
 * is an EDIT to a row older than the watermark, and the walk stops at the watermark by design.
 *
 * Proven on prod: six consecutive runs, every one `incremental:createdAt`, every one carrying the
 * advisory that /admin/players exposes no updatedAt. So edits are caught by NOTHING today, and id
 * 88053 still showed a name, email and phone here while MatchDay had it scrubbed.
 *
 * Re-fetching the row is the fix and it is the whole fix — because the scrub is in place, the
 * re-fetch overwrites the name, nulls the phone, tombstones the email and rewrites `raw` wholesale.
 * Since 2026-10-21 the daily re-fetch is the 3 AM Central full pass in playerAreaSync.ts, which
 * upserts every row it reads through mapRow; forceFull remains for a manual bootstrap. */
export async function syncMdapiUsers(
  supabase: SupabaseClient,
  opts: { forceFull?: boolean } = {},
): Promise<MdapiUsersSyncResult> {
  const startedAt = Date.now();
  // PACED (2026-10-21): one request a second, no retries, stop at the first error (matchdayApi.ts,
  // getPacedClient). The retry is the next scheduled run.
  const client = getPacedClient();
  const syncedAt = new Date().toISOString();

  /* NO SORT DETECTION ANY MORE, AND NO SEPARATE PROBE. Detection spent two requests a run asking
   * whether updatedAt sorts; it never has (every prod run since August came back createdAt, and the
   * API silently ignores unknown sort columns — docs/matchday-api-facts.md). The probe's totalItems
   * comes with page 1 of the walk itself. An incremental run is now ONE request on a normal hour. */
  let mode: SyncMode = "full";
  let cutoff: number | null = null;
  if (!opts.forceFull) {
    const wmTs = await readStoredMax(supabase, "createdAt");
    if (wmTs != null) {
      mode = "incremental:createdAt";
      cutoff = wmTs - WATERMARK_OVERLAP_MS;
    }
  }
  console.log(
    `[mdapi-users] mode=${mode}` +
      (cutoff != null ? ` cutoff=${new Date(cutoff).toISOString()}` : ""),
  );
  const fail = (e: unknown, where: string) => {
    const rawMsg = e instanceof Error ? e.message : String(e);
    const status = e instanceof MatchdayApiError ? ` (HTTP ${e.status})` : "";
    return withLogPatch(
      new Error(`mdapi_users: ${where}${status}, no retry. Upstream: ${rawMsg}`),
      { api_calls: client.calls, run_mode: mode === "full" ? "full" : "incremental" },
    );
  };

  // --- Fetch, newest first ---
  // Dedupe by id in case the API returns the same row twice across
  // pages (sort can be unstable when many rows share a timestamp).
  // Last-write-wins.
  const dedupedById = new Map<number, DbRow>();
  const unmappedSet = new Set<string>();
  let rowsReceived = 0;
  let rowsSkipped = 0;
  let pagesFetched = 0;
  let totalItems = 0;
  let totalPages = 1;

  const ingest = (rows: ApiPlayer[]) => {
    rowsReceived += rows.length;
    for (const r of rows) {
      const mapped = mapRow(r, syncedAt, unmappedSet);
      if (!mapped) {
        rowsSkipped++;
        continue;
      }
      dedupedById.set(mapped.id, mapped);
    }
  };

  for (let page = 1; page <= totalPages; page++) {
    let res: ApiPage;
    try {
      res = await client.get<ApiPage>("/admin/players", {
        page,
        limit: PAGE_LIMIT,
        sortColumn: "createdAt",
        sortDirection: "desc",
      });
    } catch (e) {
      throw fail(e, `failed on page ${page} of ~${totalPages} (${mode})`);
    }
    pagesFetched++;
    if (page === 1) {
      totalItems = typeof res.totalItems === "number" ? res.totalItems : 0;
      if (totalItems === 0) {
        // Endpoint should return at least one row in production. If we
        // somehow got zero, surface it rather than silently no-oping.
        throw fail(new Error("totalItems=0"), "page 1 returned totalItems=0 — refusing to wipe state");
      }
      totalPages = Math.ceil(totalItems / PAGE_LIMIT);
    }
    const rows = Array.isArray(res?.data) ? res.data : [];

    if (mode === "full") {
      // Strict: an unexpected empty page mid-walk aborts rather than truncating.
      ingest(rows);
      if (rows.length === 0 && page < totalPages) {
        throw fail(new Error("empty page"), `page ${page} returned 0 rows but totalPages=${totalPages}`);
      }
      continue;
    }

    // Incremental: stop once a page reaches past the cutoff, or the table ends.
    if (rows.length === 0) break;
    const cut = cutoff as number;
    const fresh: ApiPlayer[] = [];
    let sawOlder = false;
    for (const r of rows) {
      const ts = r.createdAt ? Date.parse(r.createdAt) : NaN;
      // A row with no parseable timestamp can't be judged against the cutoff — keep it rather
      // than risk dropping a real signup.
      if (Number.isNaN(ts) || ts >= cut) fresh.push(r);
      else sawOlder = true;
    }
    ingest(fresh);
    if (sawOlder || rows.length < PAGE_LIMIT) break;
  }

  // --- 5. Upsert in batches ---
  // Per-chunk timing log goes to Vercel logs (not the UI) so the next
  // statement_timeout-style failure has more diagnostic data than
  // "offset N failed". Format: chunk index / total / row count / ms.
  const dbRows = [...dedupedById.values()];
  /* Counted off the payload already in memory — no extra query, and counted AFTER the dedupe so a
   * row seen on two pages is not counted twice. The name pair is MatchDay's marker; the email
   * domain is not (six real staff accounts carry it). */
  const scrubbedSeen = dbRows.filter(
    (r) => (r.first_name ?? "").trim() === "Deleted" && (r.last_name ?? "").trim() === "Account",
  ).length;
  const totalChunks = Math.ceil(dbRows.length / UPSERT_BATCH);
  let upserted = 0;
  for (let i = 0; i < dbRows.length; i += UPSERT_BATCH) {
    const chunk = dbRows.slice(i, i + UPSERT_BATCH);
    const chunkIndex = Math.floor(i / UPSERT_BATCH) + 1;
    const t0 = Date.now();
    const { error } = await supabase
      .from("mdapi_users")
      .upsert(chunk, { onConflict: "id" });
    const ms = Date.now() - t0;
    if (error) {
      throw new Error(
        `mdapi_users upsert failed at offset ${i}: ${error.message}`,
      );
    }
    upserted += chunk.length;
    console.log(
      `[mdapi-users] upserted chunk ${chunkIndex}/${totalChunks} (${chunk.length} rows) in ${ms}ms`,
    );
  }

  return {
    mode,
    watermark: cutoff != null ? new Date(cutoff).toISOString() : null,
    totalItems,
    pagesFetched,
    rowsReceived,
    upserted,
    rowsSkipped,
    unmappedCities: [...unmappedSet].sort(),
    scrubbedSeen,
    apiCalls: client.calls,
    durationMs: Date.now() - startedAt,
  };
}

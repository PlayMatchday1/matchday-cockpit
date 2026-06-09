// Sync GET /admin/players → mdapi_users. Server-only.
//
// INCREMENTAL by default. This used to be a full ~24k-row re-sync on
// every run, which became the daily cron's budget-killer: the
// orchestrator hit its 300s maxDuration *inside* this step and got
// killed mid-run, so the four steps after it never executed. Now:
//
//   1. Authenticate via the shared MatchDay API helper.
//   2. Probe page=1&limit=1 to read totalItems (also a health check;
//      refuses to proceed on totalItems=0 so we never mistake an
//      upstream blip for "no users").
//   3. Auto-detect the watermark column. We prefer `updatedAt` so that
//      BOTH new signups AND edits to existing rows (signup completion,
//      city change, membership flip) are caught. updatedAt is used only
//      if the endpoint genuinely supports it — the sample must carry a
//      parseable updatedAt on every row AND come back monotonically
//      descending (the API silently ignores an unknown sortColumn, so
//      "accepted the param" is not enough). Otherwise we fall back to
//      `createdAt`, the historically-verified sort (new signups only).
//   4. Read the high-water mark from mdapi_users (max of the chosen
//      column) and walk pages newest→oldest, stopping once a page falls
//      entirely past (watermark − 48h overlap). The overlap re-fetches a
//      safe margin; upserts are idempotent (onConflict=id) so re-seeing
//      rows costs nothing and clock skew / late rows can't slip through.
//   5. First run / no watermark / neither sort honored → FULL sync (the
//      old behavior). A full run populates updated_at, so the next run
//      can go incremental.
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
import {
  getMatchdayApiClient,
  MatchdayApiError,
} from "./matchdayApi";
import { normalizeCityName } from "./cityNormalization";
import type { LogPatch } from "./syncLogging";

const PAGE_LIMIT = 250;
// DB-side upsert chunk size. Initial Phase 1 setting of 500 hit
// Postgres statement_timeout at offset 16000 (table has 4 indexes +
// jsonb raw column → index maintenance scales fast per-statement).
// 100 is conservative; if this still times out drop to 50, if it's
// fast we can raise later. Don't pre-optimize — this is the
// minimum-blast-radius fix.
const UPSERT_BATCH = 100;
// Politeness delay between paginated /admin/players calls. With ~96
// pages back-to-back the upstream platform has been observed to serve
// transient 503s and HTML error pages (the "Unexpected token 'A'…"
// failure mode). 200ms spreads the load and reduces upstream pressure
// at the cost of ~20s of wall-clock time across the full sync.
const INTER_PAGE_DELAY_MS = 200;
// How far back past the watermark an incremental walk re-fetches. The
// watermark is derived from data we already stored, so a margin absorbs
// clock skew, rows that landed mid-run on the previous sync, and the
// non-atomicity of paginated reads. 48h is generous and cheap (a few
// extra pages of idempotent re-upserts).
const WATERMARK_OVERLAP_MS = 48 * 60 * 60 * 1000;
// Rows pulled when sniffing whether a sortColumn is real. Small — we
// only need enough to confirm the column exists and the order is
// honored.
const DETECT_SAMPLE = 10;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type ApiPlayer = {
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

type DbRow = {
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
  apiCalls: number;
  durationMs: number;
};

// Surfaced in fin_sync_log (Recent Syncs) when the sync runs the
// less-complete createdAt fallback because /admin/players doesn't expose
// updatedAt. NOT a failure — the run completes and ok stays true — but
// it's logged so the degraded mode is never silent and is easy to grep.
export const MDAPI_USERS_CREATEDAT_FALLBACK_NOTE =
  "ADVISORY (sync OK): /admin/players does not expose updatedAt; running " +
  "createdAt incremental — new signups are captured, but edits to existing " +
  "rows (membership, city, signup completion) are NOT picked up. Revisit if " +
  "MatchDay adds updatedAt.";

// Shared fin_sync_log patch for the mdapi-users step, used by both the
// cron orchestrator and the manual /api/sync/users route so the fallback
// advisory surfaces identically wherever the sync runs.
export function mdapiUsersLogPatch(r: MdapiUsersSyncResult): LogPatch {
  return r.mode === "incremental:createdAt"
    ? { rows_imported: r.upserted, error_message: MDAPI_USERS_CREATEDAT_FALLBACK_NOTE }
    : { rows_imported: r.upserted };
}

const apiTsOf = (r: ApiPlayer, field: WatermarkField): string | null | undefined =>
  field === "updatedAt" ? r.updatedAt : r.createdAt;

// A sample is "sorted desc by field" only if every row carries a
// parseable timestamp AND the series is monotonically non-increasing.
// This is the guard against the API silently ignoring an unknown
// sortColumn and handing back its default order.
function isMonotonicDesc(values: (string | null | undefined)[]): boolean {
  if (values.length === 0) return false;
  const ts: number[] = [];
  for (const v of values) {
    if (!v) return false;
    const t = Date.parse(v);
    if (Number.isNaN(t)) return false;
    ts.push(t);
  }
  for (let i = 1; i < ts.length; i++) {
    if (ts[i - 1] < ts[i]) return false;
  }
  return true;
}

function mapRow(r: ApiPlayer, syncedAt: string, unmappedSet: Set<string>): DbRow | null {
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

export async function syncMdapiUsers(
  supabase: SupabaseClient,
): Promise<MdapiUsersSyncResult> {
  const startedAt = Date.now();
  const client = getMatchdayApiClient();
  const syncedAt = new Date().toISOString();
  let apiCalls = 0;

  // Single page fetch + call counter. Throws on terminal upstream
  // failures (fetchMatchDayJson has already burned its retries).
  const getPage = (query: Record<string, string | number>): Promise<ApiPage> => {
    apiCalls++;
    return client.get<ApiPage>("/admin/players", query);
  };

  // --- 1. Probe to learn totalItems ---
  let probe: ApiPage;
  try {
    probe = await getPage({
      page: 1,
      limit: 1,
      sortColumn: "createdAt",
      sortDirection: "desc",
    });
  } catch (e) {
    const rawMsg = e instanceof Error ? e.message : String(e);
    const status = e instanceof MatchdayApiError ? ` (HTTP ${e.status})` : "";
    throw new Error(
      `mdapi_users: /admin/players probe failed after retries${status}. Upstream: ${rawMsg}`,
    );
  }
  const totalItems = typeof probe.totalItems === "number" ? probe.totalItems : 0;
  if (totalItems === 0) {
    // Endpoint should return at least one row in production. If we
    // somehow got zero, surface it rather than silently no-oping.
    throw new Error(
      "mdapi_users: /admin/players probe returned totalItems=0 — refusing to wipe state",
    );
  }
  const totalPages = Math.ceil(totalItems / PAGE_LIMIT);

  // --- 2 + 3. Pick the incremental field + watermark, else full ---
  // Prefer updatedAt so edits to existing rows are caught; fall back to
  // createdAt (new signups only); fall back to a full sync when neither
  // sort is usable or there's no stored watermark yet (first run).
  //
  // A field is only usable if a sample comes back genuinely sorted by it
  // (the API silently ignores an unknown sortColumn, so "accepted the
  // param" is not enough) AND we can read a stored high-water mark for
  // it. updatedAt is NOT a column — it would live in the raw jsonb — so
  // its watermark read can be slow or unsupported; if it throws we DEMOTE
  // to the next field rather than fail the sync.
  let mode: SyncMode = "full";
  let walkField: WatermarkField | null = null;
  let cutoff: number | null = null;

  for (const field of ["updatedAt", "createdAt"] as const) {
    let sample: ApiPlayer[];
    try {
      const res = await getPage({
        page: 1,
        limit: DETECT_SAMPLE,
        sortColumn: field,
        sortDirection: "desc",
      });
      sample = Array.isArray(res?.data) ? res.data : [];
    } catch {
      continue; // unknown sortColumn (4xx) / transient — try next field
    }
    if (
      sample.length === 0 ||
      !isMonotonicDesc(sample.map((r) => apiTsOf(r, field)))
    ) {
      continue; // field absent or sort not honored
    }
    let wmTs: number | null;
    try {
      wmTs = await readStoredMax(supabase, field);
    } catch {
      continue; // e.g. raw->>updatedAt scan timed out — try next field
    }
    if (wmTs == null) {
      // Sort is usable but nothing stored yet → a full run bootstraps the
      // watermark. Stop here so a less-preferred field's stale watermark
      // can't mask a first run on the preferred one.
      break;
    }
    mode = `incremental:${field}` as SyncMode;
    walkField = field;
    cutoff = wmTs - WATERMARK_OVERLAP_MS;
    break;
  }
  console.log(
    `[mdapi-users] mode=${mode}` +
      (cutoff != null ? ` cutoff=${new Date(cutoff).toISOString()}` : ""),
  );

  // --- 4. Fetch (full or incremental walk) ---
  // Dedupe by id in case the API returns the same row twice across
  // pages (sort can be unstable when many rows share a timestamp).
  // Last-write-wins.
  const dedupedById = new Map<number, DbRow>();
  const unmappedSet = new Set<string>();
  let rowsReceived = 0;
  let rowsSkipped = 0;
  let pagesFetched = 0;

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

  if (mode === "full") {
    // Full re-sync: page 1..totalPages, no early stop. Strict guards —
    // an unexpected empty page mid-loop aborts rather than truncating.
    for (let page = 1; page <= totalPages; page++) {
      if (page > 1) await sleep(INTER_PAGE_DELAY_MS);
      let res: ApiPage;
      try {
        res = await getPage({
          page,
          limit: PAGE_LIMIT,
          sortColumn: "createdAt",
          sortDirection: "desc",
        });
      } catch (e) {
        const approxSynced = (page - 1) * PAGE_LIMIT;
        const rawMsg = e instanceof Error ? e.message : String(e);
        const status =
          e instanceof MatchdayApiError ? ` (HTTP ${e.status})` : "";
        throw new Error(
          `mdapi_users: Failed on page ${page} of ~${totalPages} after retries${status}. ` +
            `Synced ~${approxSynced.toLocaleString()} of ~${totalItems.toLocaleString()} users. ` +
            `Upstream: ${rawMsg}`,
        );
      }
      pagesFetched++;
      const rows = Array.isArray(res?.data) ? res.data : [];
      ingest(rows);
      if (rows.length === 0 && page < totalPages) {
        throw new Error(
          `mdapi_users: page ${page} returned 0 rows but totalPages=${totalPages}`,
        );
      }
    }
  } else {
    // Incremental walk: newest→oldest on the detected field, stop once a
    // page falls entirely past the cutoff. A short page (< PAGE_LIMIT)
    // or an empty page also ends the walk. totalPages caps the loop so a
    // misbehaving sort can never spin forever.
    const field = walkField as WatermarkField;
    const cut = cutoff as number;
    for (let page = 1; page <= totalPages; page++) {
      if (page > 1) await sleep(INTER_PAGE_DELAY_MS);
      let res: ApiPage;
      try {
        res = await getPage({
          page,
          limit: PAGE_LIMIT,
          sortColumn: field,
          sortDirection: "desc",
        });
      } catch (e) {
        const rawMsg = e instanceof Error ? e.message : String(e);
        const status =
          e instanceof MatchdayApiError ? ` (HTTP ${e.status})` : "";
        throw new Error(
          `mdapi_users: incremental fetch failed on page ${page} (field=${field})${status}. ` +
            `Upstream: ${rawMsg}`,
        );
      }
      pagesFetched++;
      const rows = Array.isArray(res?.data) ? res.data : [];
      if (rows.length === 0) break;

      const fresh: ApiPlayer[] = [];
      let sawOlder = false;
      for (const r of rows) {
        const v = apiTsOf(r, field);
        const ts = v ? Date.parse(v) : NaN;
        if (Number.isNaN(ts)) {
          // Defensive: a row with no parseable timestamp can't be
          // judged against the cutoff — keep it rather than risk
          // dropping a real update.
          fresh.push(r);
        } else if (ts >= cut) {
          fresh.push(r);
        } else {
          sawOlder = true;
        }
      }
      ingest(fresh);

      // Stop when we've crossed the cutoff or the page was short (we've
      // reached the end of the table).
      if (sawOlder || rows.length < PAGE_LIMIT) break;
    }
  }

  // --- 5. Upsert in batches ---
  // Per-chunk timing log goes to Vercel logs (not the UI) so the next
  // statement_timeout-style failure has more diagnostic data than
  // "offset N failed". Format: chunk index / total / row count / ms.
  const dbRows = [...dedupedById.values()];
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
    apiCalls,
    durationMs: Date.now() - startedAt,
  };
}

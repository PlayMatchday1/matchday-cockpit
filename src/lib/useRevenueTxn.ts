"use client";

/* LOADERS FOR fin_txn, for Finance › Revenue. Read-only.
 *
 * fin_txn_sums / fin_txn_match_sums (migration 0214) sum in the database, with sales tax rounded per
 * charge from salesTax.ts's rates (passed in, RATES_FOR_SQL); these page through
 * the result (PostgREST caps a response at 1,000 rows) and keep it in a module-level cache keyed on
 * the reader and the arguments, so a section remount or a grain switch back costs no request.
 * A FAILED PAGE IS NOT AN EMPTY RESULT: it throws, nothing is cached, and the caller shows the error. */
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/useAuth";
import { RATES_FOR_SQL, type RollupRow } from "@/lib/revenueTxn";
import { venueCategory } from "@/lib/venueResolver";

const PAGE = 1000;
const CACHE = new Map<string, Promise<unknown>>();

async function pagedRpc<T>(fn: string, args: Record<string, unknown>): Promise<T[]> {
  const acc: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.rpc(fn, args).range(from, from + PAGE - 1);
    if (error) throw new Error(`${fn}: ${error.message}`);
    const page = (data ?? []) as T[];
    acc.push(...page);
    if (page.length < PAGE) break;
  }
  return acc;
}

function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = CACHE.get(key);
  if (hit) return hit as Promise<T>;
  const p = load().catch((e) => { CACHE.delete(key); throw e; });
  CACHE.set(key, p);
  return p;
}

const asRollup = (r: Record<string, unknown>): RollupRow => ({
  period: String(r.period),
  kind: r.kind as RollupRow["kind"],
  source: String(r.source),
  type: String(r.type),
  city: (r.city as string | null) ?? null,
  fin_venue_id: r.fin_venue_id == null ? null : Number(r.fin_venue_id),
  excluded: !!r.excluded,
  n: Number(r.n),
  gross_cents: Number(r.gross_cents),
  fee_cents: Number(r.fee_cents ?? 0),
  tax_cents: Number(r.tax_cents ?? 0),
});

export type RollupArgs = { from: string; to: string; grain: "day" | "month"; byVenue: boolean; venueId?: number | null };

export function loadRollup(uid: string, a: RollupArgs): Promise<RollupRow[]> {
  const key = `r|${uid}|${a.from}|${a.to}|${a.grain}|${a.byVenue}|${a.venueId ?? ""}`;
  return cached(key, async () =>
    (await pagedRpc<Record<string, unknown>>("fin_txn_sums", {
      p_from: a.from, p_to: a.to, p_grain: a.grain, p_by_venue: a.byVenue, p_venue_id: a.venueId ?? null, ...RATES_FOR_SQL,
    })).map(asRollup));
}

export type MatchMoneyRow = { match_api_id: number; kind: string; type: string; city: string | null; excluded: boolean; n: number; gross_cents: number; tax_cents: number };

export function loadMatchRollup(uid: string, from: string, to: string): Promise<MatchMoneyRow[]> {
  return cached(`m|${uid}|${from}|${to}`, async () =>
    (await pagedRpc<Record<string, unknown>>("fin_txn_match_sums", { p_from: from, p_to: to, ...RATES_FOR_SQL })).map((r) => ({
      match_api_id: Number(r.match_api_id), kind: String(r.kind), type: String(r.type),
      city: (r.city as string | null) ?? null, excluded: !!r.excluded, n: Number(r.n), gross_cents: Number(r.gross_cents),
      tax_cents: Number(r.tax_cents ?? 0),
    })));
}

/** One async value with its loading and error state; re-runs when `key` changes. */
export function useAsync<T>(key: string | null, load: () => Promise<T>): { data: T | null; error: string | null; loading: boolean } {
  const [st, setSt] = useState<{ key: string | null; data: T | null; error: string | null }>({ key: null, data: null, error: null });
  useEffect(() => {
    if (key == null) return;
    let live = true;
    load().then(
      (d) => { if (live) setSt({ key, data: d, error: null }); },
      (e) => { if (live) setSt({ key, data: null, error: e instanceof Error ? e.message : String(e) }); },
    );
    return () => { live = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const fresh = st.key === key;
  return { data: fresh ? st.data : null, error: fresh ? st.error : null, loading: key != null && !fresh };
}

/** The reader's id, for cache keys — compared, never rendered. Null while auth is resolving. */
export function useReaderId(): string | null {
  const { appUser, isLoading } = useAuth();
  return isLoading || !appUser?.id ? null : String(appUser.id);
}

export type StatusInputs = {
  /** Most recent successful stripe-txn sync, epoch ms. */
  lastSyncMs: number | null;
  /** fin_txn rows with updated_at set in the window: the only rows that can make a month "Adjusted". */
  adjustments: { createdMs: number; updatedMs: number; cents: number }[];
};

export async function loadStatusInputs(fromIso: string, toIso: string): Promise<StatusInputs> {
  const log = await supabase.from("fin_sync_log").select("completed_at")
    // A completed run with an ADVISORY (finTxnLogPatch) succeeded; any other error_message did not.
    .eq("source", "stripe-txn").not("completed_at", "is", null)
    .or("error_message.is.null,error_message.like.ADVISORY*")
    .order("completed_at", { ascending: false }).limit(1);
  if (log.error) throw new Error(`fin_sync_log: ${log.error.message}`);
  const adj = await supabase.from("fin_txn").select("created_at_utc, updated_at, gross_cents")
    .not("updated_at", "is", null).gte("created_at_utc", fromIso).lt("created_at_utc", toIso).limit(1000);
  if (adj.error) throw new Error(`fin_txn adjustments: ${adj.error.message}`);
  const last = log.data?.[0]?.completed_at;
  return {
    lastSyncMs: last ? Date.parse(String(last)) : null,
    adjustments: (adj.data ?? []).map((r) => ({
      createdMs: Date.parse(String(r.created_at_utc)), updatedMs: Date.parse(String(r.updated_at)), cents: Number(r.gross_cents),
    })),
  };
}

/** LAUNCH = THE FIRST PLAYED MATCH (Ryan, 2026-10-10), for a field and, through its fields, a city.
 *  Played: not cancelled, not deleted, at least one player, kicked off by today (compared on the
 *  match's LOCAL wall-clock date — `start_date`'s trailing Z is not UTC). Matches on tournament and
 *  special-event fields do not count: a field title firing EVENT_MARKERS (venueResolver.ts — tourney,
 *  tournament, combine, cup, showcase, clinic, camp, invitational, special events). By NAME, as Ryan
 *  set it, so "Tourney ATH Pearland" is excluded here even though its link counts as regular play
 *  for cost. One ordered read per venue, paged until a non-event match is found.
 *  Resolves to { fin_venues.id: "YYYY-MM-DD" | null }. */
export function loadVenueLaunches(fieldsByVenue: Record<string, number[]>, todayYmd: string): Promise<Record<string, string | null>> {
  const key = `vlaunch|${todayYmd}|${Object.entries(fieldsByVenue).sort().map(([v, ids]) => `${v}:${[...ids].sort((a, b) => a - b).join(",")}`).join(";")}`;
  return cached(key, async () => {
    const out: Record<string, string | null> = {};
    await Promise.all(Object.entries(fieldsByVenue).map(async ([vid, ids]) => {
      out[vid] = null;
      if (ids.length === 0) return;
      for (let from = 0; from < 2000; from += 100) {
        const { data, error } = await supabase.from("mdapi_matches").select("start_date, field_title")
          .in("field_id", ids).eq("is_cancelled", false).is("deleted_at", null).gt("player_count", 0)
          .lte("start_date", `${todayYmd}T23:59:59Z`)
          .order("start_date", { ascending: true }).order("api_id", { ascending: true }).range(from, from + 99);
        if (error) throw new Error(`mdapi_matches (launch of venue ${vid}): ${error.message}`);
        const hit = (data ?? []).find((m) => venueCategory(m.field_title) !== "event");
        if (hit?.start_date) { out[vid] = String(hit.start_date).slice(0, 10); return; }
        if (!data || data.length < 100) return;
      }
    }));
    return out;
  });
}

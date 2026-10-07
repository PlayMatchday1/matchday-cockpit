/* VENMO INTO fin_txn — the manual rows, copied from fin_revenue on every stripe-txn run (hourly,
 * daily and Sync now; never the month back-fill). Ryan, 2026-10-07.
 *
 * fin_revenue is where a Venmo payment is ENTERED (the Revenue admin form) and stays the record.
 * fin_txn holds a copy so the Revenue page can read one table. The copy is keyed on source_id
 * 'fin_revenue:<id>' — the same key scripts/load-venmo-fin-txn.mjs wrote for history, with the same
 * mapping, so the first run after that load finds nothing to do. If it ever reports inserts or
 * updates for old rows, the two mappings have drifted.
 *
 *   new row in fin_revenue      → inserted
 *   amount or date changed      → updated, updated_at stamped ("Adjusted after final") — a new
 *                                 date moves the money between months
 *   city, type, venue or note   → updated, NOT stamped — the same rule as a Stripe row's city
 *   row gone from fin_revenue   → NOT deleted. Reported as an advisory: a vanished payment in a
 *                                 final month is exactly what somebody should look at, and a
 *                                 silent delete would leave no trace of it.
 *
 * It only READS fin_revenue. */
import type { SupabaseClient } from "@supabase/supabase-js";
import { BUSINESS_TZ, zonedWallClockToUtcMs } from "./businessHours";

export type VenmoMirrorResult = { inserted: number; updated: number; attributed: number; orphaned: string[] };

/** Noon Central on the row's date: the Central day of the stored instant is always fin_revenue's date. */
export const venmoInstant = (ymd: string): string => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(zonedWallClockToUtcMs(y, m, d, 12, 0, BUSINESS_TZ)).toISOString();
};

export async function mirrorVenmo(sb: SupabaseClient): Promise<VenmoMirrorResult> {
  const src = await sb.from("fin_revenue").select("id,date,city,venue,type,gross,notes").eq("source", "Venmo");
  if (src.error) throw new Error(`fin_revenue Venmo read failed: ${src.error.message}`);
  const ven = await sb.from("fin_venues").select("id,venue_name,city");
  if (ven.error) throw new Error(`fin_venues read failed: ${ven.error.message}`);
  const have = await sb.from("fin_txn").select("id,source_id,created_at_utc,gross_cents,city,type,fin_venue_id,description,updated_at").eq("source", "Venmo");
  if (have.error) throw new Error(`fin_txn Venmo read failed: ${have.error.message}`);

  const venueId = (name: string | null, city: string | null) =>
    name == null ? null : (ven.data ?? []).find((v) => v.venue_name === name && v.city === city)?.id ?? null;
  const byKey = new Map((have.data ?? []).map((r) => [String(r.source_id), r]));
  const keys = new Set<string>();
  const inserts: Record<string, unknown>[] = [];
  let updated = 0, attributed = 0;

  for (const r of src.data ?? []) {
    const key = `fin_revenue:${r.id}`;
    keys.add(key);
    const cents = Math.round(Number(r.gross) * 100);
    const row = {
      created_at_utc: venmoInstant(String(r.date)), kind: "manual",
      gross_cents: cents, fee_cents: 0, net_cents: cents,
      city: r.city, type: r.type, field_id: null, fin_venue_id: venueId(r.venue, r.city),
      balance_txn_id: null, source_id: key,
      is_test: false, is_internal: false, exclude_reason: null,
      source: "Venmo", description: r.notes,
    };
    const was = byKey.get(key);
    if (!was) { inserts.push(row); continue; }
    const amount = was.gross_cents !== cents || Date.parse(String(was.created_at_utc)) !== Date.parse(row.created_at_utc);
    const other = was.city !== row.city
      || was.type !== row.type || (was.fin_venue_id ?? null) !== row.fin_venue_id || (was.description ?? null) !== (row.description ?? null);
    if (!amount && !other) continue;
    const { error } = await sb.from("fin_txn").update({ ...row, updated_at: amount ? new Date().toISOString() : was.updated_at }).eq("id", was.id);
    if (error) throw new Error(`fin_txn Venmo update failed: ${error.message}`);
    if (amount) updated++; else attributed++;
  }
  if (inserts.length) {
    const { error } = await sb.from("fin_txn").insert(inserts);
    if (error) throw new Error(`fin_txn Venmo insert failed: ${error.message}`);
  }
  const orphaned = [...byKey.keys()].filter((k) => !keys.has(k));
  return { inserted: inserts.length, updated, attributed, orphaned };
}

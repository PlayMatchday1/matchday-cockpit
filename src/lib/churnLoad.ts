/* CHURN — server reads for /api/lifecycle/churn. Read only. The pure rules are in churnModel.ts.
 *
 * WHAT IS CACHED, AND WHY. churn_player_field changes once a night (13:20 UTC), so a warm instance keeps
 * it, the people's names/phones/emails and the city list for 10 minutes; the filter, the tiers, the sort
 * and the page are worked out per request from that. Former staff and the win-back log are read fresh on
 * every request, so a flag or a "Messaged" shows at once.
 *
 * LIVE FIELDS come from the MatchDay field directory (GET /cities + GET /admin/fields, the same two reads
 * Master Schedule makes), which leaves out soft-deleted fields. Cached an hour; if it cannot be read the
 * field list falls back to every venue in range and says so. */

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchCityDirectory } from "./cityDirectoryServer";
import { buildPeople, isScrubbed, type FieldRow, type Person, type Winback } from "./churnModel";

type Row = Record<string, unknown>;
async function all<T = Row>(q: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await q(from, from + 999);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

export type Contact = { name: string | null; phone: string | null; scrubbed: boolean };
export type Base = {
  people: Person[];
  contact: Map<number, Contact>;
  cities: { code: string; name: string }[];
  refreshedAt: string | null;
};

let baseCache: { at: number; base: Base } | null = null;
let baseBuilding: Promise<Base> | null = null;
const BASE_MS = 10 * 60 * 1000;

async function buildBase(sb: SupabaseClient): Promise<Base> {
  const rows = await all<FieldRow & { refreshed_at: string }>((f, t) =>
    sb.from("churn_player_field").select("person_id, venue_key, venue_label, city, matches, managed, booking_cents, membership_cents, first_played, last_played, ever_member, refreshed_at")
      .order("person_id").order("venue_key").range(f, t));
  const people = buildPeople(rows.map((r) => ({ ...r, booking_cents: Number(r.booking_cents), membership_cents: Number(r.membership_cents) })));
  const refreshedAt = rows.reduce<string | null>((a, r) => (!a || r.refreshed_at > a ? r.refreshed_at : a), null);

  const contact = new Map<number, Contact>();
  const ids = people.map((p) => p.id);
  for (let i = 0; i < ids.length; i += 500) {
    const { data, error } = await sb.from("mdapi_users").select("id, first_name, last_name, email, phone_number").in("id", ids.slice(i, i + 500));
    if (error) throw new Error(`mdapi_users: ${error.message}`);
    for (const u of (data ?? []) as Row[]) {
      const name = `${String(u.first_name ?? "").trim()} ${String(u.last_name ?? "").trim()}`.trim();
      contact.set(Number(u.id), { name: name || null, phone: (u.phone_number as string | null) ?? null, scrubbed: isScrubbed(u.email as string | null) });
    }
  }

  const { data: gc, error: gcErr } = await sb.from("growth_cities").select("name, short_code, hidden, sort_order").order("sort_order");
  if (gcErr) throw new Error(`growth_cities: ${gcErr.message}`);
  const cities = ((gc ?? []) as Row[]).filter((c) => c.hidden !== true && c.short_code).map((c) => ({ code: String(c.short_code), name: String(c.name) }));
  return { people, contact, cities, refreshedAt };
}

export async function loadBase(sb: SupabaseClient, fresh = false): Promise<Base> {
  if (!fresh && baseCache && Date.now() - baseCache.at < BASE_MS) return baseCache.base;
  if (!baseBuilding) {
    baseBuilding = buildBase(sb).then((b) => { baseCache = { at: Date.now(), base: b }; return b; }).finally(() => { baseBuilding = null; });
  }
  return baseBuilding;
}

/* ── LIVE FIELDS → venue keys (churn_player_field's keys) ─────────────────────────────────────── */
let liveCache: { at: number; keys: Set<number> } | null = null;
const LIVE_MS = 60 * 60 * 1000;
export async function liveVenueKeys(sb: SupabaseClient): Promise<Set<number> | null> {
  if (liveCache && Date.now() - liveCache.at < LIVE_MS) return liveCache.keys;
  try {
    const dir = await fetchCityDirectory("production");
    const ids = dir.flatMap((c) => c.fields.map((f) => f.id));
    const { data, error } = await sb.from("fin_venue_fields").select("mdapi_field_id, fin_venue_id, excluded_from_venue").in("mdapi_field_id", ids);
    if (error) throw new Error(error.message);
    const linked = new Map<number, number>();
    for (const r of (data ?? []) as Row[]) if (r.excluded_from_venue !== true) linked.set(Number(r.mdapi_field_id), Number(r.fin_venue_id));
    const keys = new Set(ids.map((id) => linked.get(id) ?? -id));
    liveCache = { at: Date.now(), keys };
    return keys;
  } catch (e) {
    console.warn(`[churn] live field list unavailable: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** Former staff (0266), read fresh. */
export async function formerStaff(sb: SupabaseClient): Promise<Set<number>> {
  const { data, error } = await sb.from("player_former_staff").select("person_id").eq("former_staff", true);
  if (error) throw new Error(`player_former_staff: ${error.message}`);
  return new Set(((data ?? []) as Row[]).map((r) => Number(r.person_id)));
}

/** Win-back state for these people: the latest SENT message from Churn, and whether they booked after it. */
export async function winbacks(sb: SupabaseClient, personIds: number[]): Promise<Map<number, Winback>> {
  const out = new Map<number, Winback>();
  if (personIds.length === 0) return out;
  const sent = new Map<number, string>();
  for (let i = 0; i < personIds.length; i += 500) {
    const { data, error } = await sb.from("churn_winback").select("person_id, messaged_at").in("person_id", personIds.slice(i, i + 500))
      .not("message_id", "is", null).order("messaged_at", { ascending: false });
    if (error) throw new Error(`churn_winback: ${error.message}`);
    for (const r of (data ?? []) as Row[]) if (!sent.has(Number(r.person_id))) sent.set(Number(r.person_id), String(r.messaged_at));
  }
  if (sent.size === 0) return out;
  // A person's accounts: their own id plus any deleted account growth_person_link maps onto them.
  const pids = [...sent.keys()];
  const accountsOf = new Map<number, number[]>(pids.map((p) => [p, [p]]));
  const { data: links, error: lErr } = await sb.from("growth_person_link").select("account_id, person_id").in("person_id", pids);
  if (lErr) throw new Error(`growth_person_link: ${lErr.message}`);
  for (const l of (links ?? []) as Row[]) accountsOf.get(Number(l.person_id))?.push(Number(l.account_id));
  for (const [pid, at] of sent) {
    const { data, error } = await sb.from("mdapi_match_players").select("api_id, created_at")
      .in("user_id", accountsOf.get(pid)!).gt("created_at", at).is("deleted_at", null).is("canceled_at", null)
      .neq("paid_status", "WAITING").eq("user_type", "PLAYER").order("created_at").limit(1);
    if (error) throw new Error(`mdapi_match_players: ${error.message}`);
    const booked = (data ?? []) as Row[];
    out.set(pid, booked.length > 0 ? { state: "came_back", at: String(booked[0].created_at) } : { state: "messaged", at });
  }
  return out;
}

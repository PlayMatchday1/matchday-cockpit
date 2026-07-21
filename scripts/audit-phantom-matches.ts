// READ-ONLY phantom-match audit. Authenticates to the MatchDay API the
// same way mdapiMatchesSync does (POST /auth/signin -> bearer; GET
// /admin/matches), pulls the full upstream id set for 2026, and diffs it
// against local mdapi_matches to find phantoms (rows deleted upstream but
// still local). Then quantifies the May per_match field-cost inflation.
// Makes NO writes to anything. Only GET requests + one signin POST.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = readFileSync(
  "/Users/ryanmancuso/Code/matchday-cockpit/.env.local",
  "utf8",
);
const unq = (s: string) => s.trim().replace(/^["']|["']$/g, "");
const get = (k: string) => {
  const m = env.match(new RegExp(`${k}=(.+)`));
  return m ? unq(m[1]) : "";
};
const sb = createClient(
  get("NEXT_PUBLIC_SUPABASE_URL"),
  get("SUPABASE_SERVICE_ROLE_KEY"),
);
const BASE = get("MATCHDAY_API_BASE_URL") || "https://playmatchday.herokuapp.com";
const EMAIL = get("MATCHDAY_API_EMAIL");
const PASSWORD = get("MATCHDAY_API_PASSWORD");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function signin(): Promise<string> {
  const res = await fetch(`${BASE}/auth/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`signin ${res.status}: ${txt.slice(0, 200)}`);
  const j = JSON.parse(txt);
  const token =
    j.accessToken ?? j.access_token ?? j.data?.accessToken ?? j.token;
  if (!token) throw new Error(`no token in signin response: ${txt.slice(0, 200)}`);
  return token;
}

async function apiGet(token: string, path: string, q: Record<string, string | number>) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(q)) url.searchParams.set(k, String(v));
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 429 || res.status >= 500) {
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    const txt = await res.text();
    return { status: res.status, body: txt };
  }
  return { status: 0, body: "retries exhausted" };
}

async function pullAllUpstream(token: string) {
  const ids = new Map<number, { date: string; field: string; cancelled: boolean }>();
  let page = 1;
  let total = Infinity;
  while ((page - 1) * 100 < total) {
    const { status, body } = await apiGet(token, "/admin/matches", {
      page,
      limit: 100,
      fromDate: "2026-01-01",
      toDate: "2026-12-31",
      sortColumn: "startDate",
      sortDirection: "asc",
    });
    if (status !== 200) throw new Error(`list page ${page} -> ${status}: ${body.slice(0, 200)}`);
    const j = JSON.parse(body);
    const data = j.data ?? [];
    total = j.totalItems ?? data.length;
    for (const m of data) {
      ids.set(Number(m.id), {
        date: String(m.startDate ?? "").slice(0, 10),
        field: m.field?.title ?? "?",
        cancelled: !!m.isCancelled,
      });
    }
    if (data.length === 0) break;
    page++;
    await sleep(150);
  }
  return ids;
}

async function main() {
  console.log(`Base: ${BASE}`);
  const token = await signin();
  console.log("Signed in OK.\n");

  // ---- 1. Confirm #14927 at the source ----
  console.log("===== 1. Match #14927 (Carroll Senior HS Jun 4) =====");
  const players14927 = await apiGet(token, "/admin/matches/14927/players", {});
  console.log(`  GET /admin/matches/14927/players -> HTTP ${players14927.status}`);
  console.log(`  body: ${players14927.body.slice(0, 160)}`);

  // ---- Pull full upstream id set ----
  console.log("\nPulling full upstream match list for 2026...");
  const upstream = await pullAllUpstream(token);
  console.log(`  upstream matches in 2026: ${upstream.size}`);
  console.log(`  #14927 present upstream? ${upstream.has(14927) ? "YES" : "NO (phantom)"}`);

  // ---- 2. Suspect list ----
  console.log("\n===== 2. extra_in_db suspects =====");
  const suspects: Record<number, string> = {
    14927: "Carroll Senior HS Jun 4",
    14909: "Scissortail Jun 2",
    14861: "Scissortail Jun 3",
    14862: "Scissortail Jun 4",
    14845: "Scissortail Jun 7",
    15174: "Onion Creek Jun 4 (dup)",
  };
  for (const [idStr, label] of Object.entries(suspects)) {
    const id = Number(idStr);
    console.log(`  #${id} ${label.padEnd(28)} -> ${upstream.has(id) ? "REAL (exists upstream)" : "PHANTOM (deleted upstream)"}`);
  }

  // ---- venue maps ----
  const { data: vfields } = await sb
    .from("fin_venue_fields")
    .select("fin_venue_id, mdapi_field_id");
  const fieldToVenue = new Map<number, number>();
  for (const vf of vfields ?? []) fieldToVenue.set(vf.mdapi_field_id, vf.fin_venue_id);
  const { data: venues } = await sb
    .from("fin_venues")
    .select("id, venue_name, city, billing_type, per_match_rate, charge_on_cancel");
  const venueById = new Map<number, any>();
  for (const v of venues ?? []) venueById.set(v.id, v);

  // ---- Local rows: pull ALL 2026 mdapi_matches (paged past 1000 cap) ----
  async function localAll() {
    const rows: any[] = [];
    let from = 0;
    while (true) {
      const { data, error } = await sb
        .from("mdapi_matches")
        .select("api_id, field_id, field_title, city_identifier, start_date, is_cancelled, max_player_count")
        .gte("start_date", "2026-01-01T00:00:00")
        .lte("start_date", "2026-12-31T23:59:59")
        .order("api_id")
        .range(from, from + 999);
      if (error) throw error;
      rows.push(...(data ?? []));
      if (!data || data.length < 1000) break;
      from += 1000;
    }
    return rows;
  }
  const local = await localAll();
  console.log(`\nLocal mdapi_matches in 2026: ${local.length}`);

  const phantoms = local.filter((r) => !upstream.has(Number(r.api_id)));
  const ymd = (s: string) => String(s).slice(0, 10);
  const ym = (s: string) => String(s).slice(0, 7);

  // ---- 3. Blast radius: last 90 days (2026-03-06 .. 2026-06-04) ----
  const W_FROM = "2026-03-06";
  const W_TO = "2026-06-04";
  const local90 = local.filter((r) => ymd(r.start_date) >= W_FROM && ymd(r.start_date) <= W_TO);
  const phantom90 = phantoms.filter((r) => ymd(r.start_date) >= W_FROM && ymd(r.start_date) <= W_TO);
  console.log(`\n===== 3. BLAST RADIUS =====`);
  console.log(`  Full 2026: ${phantoms.length}/${local.length} phantom (${((phantoms.length/local.length)*100).toFixed(1)}%)`);
  console.log(`  Last 90d (${W_FROM}..${W_TO}): ${phantom90.length}/${local90.length} phantom (${local90.length?((phantom90.length/local90.length)*100).toFixed(1):0}%)`);

  const byVenue = new Map<string, number>();
  const byCity = new Map<string, number>();
  const byMonth = new Map<string, number>();
  const byCancel = new Map<string, number>();
  for (const r of phantoms) {
    byVenue.set(r.field_title ?? "?", (byVenue.get(r.field_title ?? "?") ?? 0) + 1);
    byCity.set(r.city_identifier ?? "?", (byCity.get(r.city_identifier ?? "?") ?? 0) + 1);
    byMonth.set(ym(r.start_date), (byMonth.get(ym(r.start_date)) ?? 0) + 1);
    byCancel.set(String(r.is_cancelled), (byCancel.get(String(r.is_cancelled)) ?? 0) + 1);
  }
  const top = (m: Map<string, number>, n = 20) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
  console.log("\n  phantoms by month:");
  for (const [k, v] of [...byMonth.entries()].sort()) console.log(`    ${k}: ${v}`);
  console.log("\n  phantoms by is_cancelled:");
  for (const [k, v] of byCancel) console.log(`    is_cancelled=${k}: ${v}`);
  console.log("\n  phantoms by city:");
  for (const [k, v] of top(byCity)) console.log(`    ${k}: ${v}`);
  console.log("\n  phantoms by venue (top 20):");
  for (const [k, v] of top(byVenue)) console.log(`    ${String(k).padEnd(34)} ${v}`);

  // ---- 4. May 2026 per_match financial impact ----
  console.log(`\n===== 4. MAY 2026 FIELD-COST INFLATION (per_match venues) =====`);
  const mayPhantoms = phantoms.filter((r) => ym(r.start_date) === "2026-05");
  const perVenueInflation = new Map<number, { name: string; rate: number; billed: number; amt: number }>();
  let totalInflation = 0;
  for (const r of mayPhantoms) {
    const vId = r.field_id != null ? fieldToVenue.get(r.field_id) : undefined;
    if (vId == null) continue;
    const v = venueById.get(vId);
    if (!v || v.billing_type !== "per_match") continue;
    // Mirror financeStats: alive billed always; cancelled billed only if charge_on_cancel.
    const billed = r.is_cancelled === true ? !!v.charge_on_cancel : true;
    if (!billed) continue;
    const rate = Number(v.per_match_rate ?? 0);
    const cur = perVenueInflation.get(vId) ?? { name: v.venue_name, rate, billed: 0, amt: 0 };
    cur.billed += 1;
    cur.amt += rate;
    perVenueInflation.set(vId, cur);
    totalInflation += rate;
  }
  console.log(`  May phantoms total: ${mayPhantoms.length}`);
  console.log(`  May phantoms at per_match venues that WOULD bill:`);
  for (const [, c] of perVenueInflation) {
    console.log(`    ${c.name.padEnd(24)} rate $${c.rate} x ${c.billed} = $${c.amt}`);
  }
  console.log(`  >>> Additional May field cost owed back (phantom inflation): $${totalInflation.toFixed(2)}`);

  // Per_match venues with non-zero rate (context)
  console.log(`\n  (per_match venues + rates for reference:)`);
  for (const v of venues ?? []) {
    if (v.billing_type === "per_match")
      console.log(`    ${String(v.venue_name).padEnd(24)} rate=$${v.per_match_rate ?? 0} charge_on_cancel=${v.charge_on_cancel}`);
  }

  // ---- Dump the May phantom rows for inspection ----
  console.log(`\n  May phantom rows:`);
  for (const r of mayPhantoms.sort((a,b)=>String(a.start_date).localeCompare(String(b.start_date)))) {
    const vId = r.field_id != null ? fieldToVenue.get(r.field_id) : undefined;
    const v = vId != null ? venueById.get(vId) : null;
    console.log(`    #${r.api_id} ${ymd(r.start_date)} ${String(r.field_title).padEnd(28)} cancelled=${r.is_cancelled} venue=${v?.venue_name ?? "(unmapped)"} bt=${v?.billing_type ?? "-"}`);
  }
}

main().catch((e) => {
  console.error("ERROR:", e.message ?? e);
  process.exit(1);
});

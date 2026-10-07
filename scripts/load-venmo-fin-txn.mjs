// LOAD THE MANUAL VENMO ROWS from fin_revenue into fin_txn (Ryan, 2026-10-07).
//   node scripts/load-venmo-fin-txn.mjs           dry run: prints every row it would write
//   node scripts/load-venmo-fin-txn.mjs --write   ONE insert, no retry, then reads back
//
// WHAT IS COPIED. Every fin_revenue row with source='Venmo' (27 today, Mar–Sep 2026), as
//   kind 'manual', source 'Venmo', gross = fees 0 = net, city and type as entered, the venue by name
//   from fin_venues, description = the row's notes, source_id 'fin_revenue:<id>' so each row traces
//   back to the one it came from. balance_txn_id stays NULL: it is Stripe's key and these never went
//   through Stripe.
// WHEN. fin_revenue stores a date, not an instant. fin_txn stores an instant and derives the Central
//   day from it, so each row is written at NOON America/Chicago on its date — the offset is resolved
//   per date (CST before Mar 8 2026, CDT after), so the Central day always equals fin_revenue's date.
// RE-RUNNABLE ONLY AS A NO-OP. It refuses to write if fin_txn already holds any source='Venmo' row:
//   with no Stripe key to conflict on, a second insert would double every Venmo dollar.
// fin_revenue IS ONLY READ.
process.loadEnvFile(".env.local");
const { createClient } = await import("@supabase/supabase-js");
const WRITE = process.argv.includes("--write");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL.trim(), process.env.SUPABASE_SERVICE_ROLE_KEY.trim(), { auth: { persistSession: false } });

const src = await sb.from("fin_revenue").select("id,date,city,venue,type,gross,fees,net,notes").eq("source", "Venmo").order("date").order("id");
if (src.error) throw new Error(`fin_revenue read failed: ${src.error.message}`);
const ven = await sb.from("fin_venues").select("id,venue_name,city");
if (ven.error) throw new Error(`fin_venues read failed: ${ven.error.message}`);
const venueId = (name, city) => {
  if (name == null) return null;
  const hit = ven.data.filter((v) => v.venue_name === name && v.city === city);
  if (hit.length !== 1) throw new Error(`venue "${name}" (${city}) matches ${hit.length} fin_venues rows`);
  return hit[0].id;
};

/** Noon Central on a YYYY-MM-DD, as a UTC ISO instant, DST resolved for that date. */
const noonCentral = (ymd) => {
  const guess = new Date(`${ymd}T17:00:00Z`);   // noon CDT
  const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", hourCycle: "h23" }).format(guess));
  const iso = new Date(guess.getTime() + (12 - h) * 3_600_000).toISOString();
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date(iso));
  if (day !== ymd) throw new Error(`${ymd}: noon Central landed on ${day}`);
  return iso;
};

const rows = src.data.map((r) => {
  const cents = Math.round(Number(r.gross) * 100);
  if (!Number.isInteger(cents) || cents <= 0 || Number(r.fees) !== 0 || Math.round(Number(r.net) * 100) !== cents) throw new Error(`fin_revenue ${r.id}: unexpected amounts ${JSON.stringify(r)}`);
  return {
    created_at_utc: noonCentral(r.date), kind: "manual",
    gross_cents: cents, fee_cents: 0, net_cents: cents,
    city: r.city, type: r.type, field_id: null, fin_venue_id: venueId(r.venue, r.city),
    balance_txn_id: null, source_id: `fin_revenue:${r.id}`,
    is_test: false, is_internal: false, exclude_reason: null,
    source: "Venmo", description: r.notes,
  };
});

const byMonth = {};
for (const r of src.data) byMonth[r.date.slice(0, 7)] = (byMonth[r.date.slice(0, 7)] ?? 0) + 1;
console.log(`fin_revenue Venmo rows: ${rows.length}, $${(rows.reduce((s, r) => s + r.gross_cents, 0) / 100).toFixed(2)}; by month ${JSON.stringify(byMonth)}`);
for (const r of rows) console.log(`  ${r.source_id.padEnd(17)} ${r.created_at_utc}  ${(r.gross_cents / 100).toFixed(2)}  ${r.city} · ${r.type} · venue ${r.fin_venue_id ?? "—"} · ${r.description ?? ""}`);

const have = await sb.from("fin_txn").select("id", { count: "exact", head: true }).eq("source", "Venmo");
if (have.error) throw new Error(`fin_txn read failed: ${have.error.message}`);
if (have.count) { console.log(`NOT APPLIED — fin_txn already holds ${have.count} Venmo rows.`); process.exit(1); }

if (!WRITE) { console.log("DRY RUN — nothing written. Add --write to insert."); process.exit(0); }
const ins = await sb.from("fin_txn").insert(rows).select("id");
console.log("insert:", ins.error ? `FAILED ${ins.error.message}` : `LANDED ${ins.data.length} rows`);
// READ BACK, independent of what was sent.
const back = await sb.from("fin_txn").select("gross_cents").eq("source", "Venmo");
console.log("read back:", back.error ? back.error.message : `${back.data.length} Venmo rows, $${(back.data.reduce((s, r) => s + r.gross_cents, 0) / 100).toFixed(2)}`);
if (ins.error) process.exit(1);

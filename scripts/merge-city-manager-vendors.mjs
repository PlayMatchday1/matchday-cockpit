// ONE SHAPE FOR CITY MANAGER PAY — the person's name in `vendor`, on every row.
//
// WHAT WAS WRONG. fin_expenses held two seeding batches for the same six people. Apr–Jun 2026 put
// the name in `vendor` and a sentence in `notes` ("April CM payment"). Jul–Sep 2026 left `vendor`
// NULL and put the bare name in `notes`. Nothing double-counted — the batches abut, they do not
// overlap — but every consumer that groups on vendor saw one person as two line items, and three
// people were spelled two ways across the seam.
//
// WHY A SCRIPT AND NOT A ROUTE. There is no expense API route: the panel writes client-side through
// updateFinExpense(). This is a one-off backfill of 20 rows, not a panel action, so it runs here
// with the service role — server-side, never from a browser, and never subject to the RLS silent
// no-op. It is deliberately NOT wired to anything.
//
// SAFETY. Serial, one row at a time. Every write is preceded by a fin_change_log entry carrying the
// full before_json, and followed by a read-back that confirms the stored vendor is the intended one.
// AMOUNT, DATE, MONTH, CITY AND CATEGORY ARE NEVER IN AN UPDATE PAYLOAD — the six monthly totals are
// computed before and after and compared, and a single cent of drift aborts the report.
//
//   node scripts/merge-city-manager-vendors.mjs          # dry run, prints the plan
//   node scripts/merge-city-manager-vendors.mjs --apply  # writes

import { createClient } from "@supabase/supabase-js";
process.loadEnvFile(".env.local");

const APPLY = process.argv.includes("--apply");
const ACTOR = "rmancuso@playmatchday.com";
const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// THE CANONICAL SPELLINGS, each decided by an external source of truth rather than by preference.
// city_managers is the operational roster; app_users is the sign-in identity. Where they agree the
// answer is not a judgement call.
const CANON = {
  yarra: "Yara",       // city_managers "Yara" + app_users "Yara Usheta" — both agree, shorter form wins on evidence
  yara: "Yara",
  abraham: "Abraham",  // city_managers "Abraham" + app_users "Abraham Garcia" — both agree
  abra: "Abraham",
  willfried: "Wilfried",
  wilfried: "Wilfried", // city_managers "Wilfried"; no app_users row. Single L.
};
const canonical = (n) => CANON[(n ?? "").trim().toLowerCase()] ?? (n ?? "").trim();

const MONTHS = ["Apr 2026", "May 2026", "Jun 2026", "Jul 2026", "Aug 2026", "Sep 2026"];
const fetchAll = async () =>
  (await svc.from("fin_expenses").select("id,date,month,city,category,vendor,notes,amount,manual_entry")
     .eq("category", "City Manager").order("id")).data ?? [];

const totalsOf = (rows) => Object.fromEntries(MONTHS.map((m) =>
  [m, Math.round(rows.filter((r) => r.month === m).reduce((s, r) => s + Number(r.amount), 0) * 100) / 100]));

const before = await fetchAll();
const totalsBefore = totalsOf(before);

// ── THE PLAN ────────────────────────────────────────────────────────────────────────────────────
const plan = [];
for (const r of before) {
  // PHILLY IS LEFT ALONE. #548 carries city NULL, so it sits under Company-wide rather than a city.
  // Which city it belongs to is Ryan's call, and guessing it would move money between cities.
  if (r.city === null) continue;

  const fromNotes = r.vendor === null && r.notes && r.notes.trim() !== "";
  const target = canonical(fromNotes ? r.notes : r.vendor);
  if (!target) continue;

  const vendorChanges = (r.vendor ?? null) !== target;
  // notes is cleared ONLY where it was nothing but the name being moved out of it. A notes field
  // carrying real information ("El Paso paused — partial payment") is never touched.
  const notesIsJustTheName = fromNotes && canonical(r.notes) === target;
  if (!vendorChanges && !notesIsJustTheName) continue;

  const updates = {};
  if (vendorChanges) updates.vendor = target;
  if (notesIsJustTheName) updates.notes = null;
  plan.push({ row: r, updates, target, why: fromNotes ? "name moved out of notes" : `spelling → ${target}` });
}

console.log(`── PLAN: ${plan.length} of ${before.length} rows change; ${before.length - plan.length} are already correct or held back ──\n`);
for (const p of plan) {
  console.log(`  #${String(p.row.id).padEnd(5)} ${p.row.month.padEnd(9)} ${String(p.row.city).padEnd(12)} ` +
    `vendor ${JSON.stringify(p.row.vendor)} → ${JSON.stringify(p.updates.vendor ?? p.row.vendor)}` +
    `${"notes" in p.updates ? `, notes ${JSON.stringify(p.row.notes)} → null` : ""}   (${p.why})`);
}

// A payload may never carry a money or bucketing column. This is a guard, not a comment.
const FORBIDDEN = ["amount", "date", "month", "city", "category", "id"];
for (const p of plan) {
  const bad = Object.keys(p.updates).filter((k) => FORBIDDEN.includes(k));
  if (bad.length) { console.error(`\nABORT — row #${p.row.id} payload touches ${bad.join(", ")}`); process.exit(1); }
}
console.log(`\n  guard: no payload touches ${FORBIDDEN.join("/")} ✓`);

if (!APPLY) { console.log("\nDRY RUN — nothing written. Re-run with --apply."); process.exit(0); }

// ── THE WRITES, ONE AT A TIME ───────────────────────────────────────────────────────────────────
console.log("\n── WRITING, serially ──\n");
const outcomes = [];
for (const p of plan) {
  const r = p.row;
  let outcome = "UNKNOWN", detail = "";
  try {
    // AUDIT BEFORE THE WRITE, so a failure can never leave an unlogged change. Same table and same
    // columns as logChange() in src/lib/financeAudit.ts, which this script cannot import (it builds
    // the browser client at module scope).
    const log = await svc.from("fin_change_log").insert({
      table_name: "fin_expenses", row_id: r.id, action: "update", changed_by: ACTOR,
      before_json: r, after_json: { ...r, ...p.updates },
      note: "city manager vendor merge — names only, no amount/date/month/city/category change",
    });
    if (log.error) throw new Error(`audit refused: ${log.error.message}`);

    const { data, error } = await svc.from("fin_expenses")
      .update({ ...p.updates, updated_at: new Date().toISOString() })
      .eq("id", r.id).select("id,vendor,notes,amount,month,city,category").maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) { outcome = "NOT APPLIED"; detail = "update matched no rows"; }
    else {
      // READ BACK from a fresh query, not from the update's own echo.
      const back = (await svc.from("fin_expenses").select("id,vendor,notes,amount,month,city,category")
        .eq("id", r.id).maybeSingle()).data;
      const vendorOk = back?.vendor === (p.updates.vendor ?? r.vendor);
      const notesOk = !("notes" in p.updates) || back?.notes === null;
      const untouched = Number(back?.amount) === Number(r.amount) && back?.month === r.month
        && back?.city === r.city && back?.category === r.category;
      if (vendorOk && notesOk && untouched) outcome = "LANDED";
      else { outcome = "FAILED"; detail = !untouched ? "a protected column moved" : `stored vendor ${JSON.stringify(back?.vendor)}`; }
    }
  } catch (e) { outcome = "FAILED"; detail = e.message; }
  outcomes.push({ id: r.id, month: r.month, city: r.city, to: p.target, outcome, detail });
  console.log(`  ${outcome.padEnd(12)} #${String(r.id).padEnd(5)} ${r.month.padEnd(9)} ${String(r.city).padEnd(12)} → ${p.target}${detail ? "   " + detail : ""}`);
}

// ── THE TOTALS MUST NOT HAVE MOVED ──────────────────────────────────────────────────────────────
const after = await fetchAll();
const totalsAfter = totalsOf(after);
console.log("\n── MONTHLY TOTALS, before vs after ──");
let drift = 0;
for (const m of MONTHS) {
  const same = totalsBefore[m] === totalsAfter[m];
  if (!same) drift++;
  console.log(`  ${m}   before $${String(totalsBefore[m]).padEnd(8)} after $${String(totalsAfter[m]).padEnd(8)} ${same ? "unchanged ✓" : "*** MOVED ***"}`);
}
console.log(`  row count  before ${before.length}  after ${after.length}  ${before.length === after.length ? "unchanged ✓" : "*** MOVED ***"}`);

const failed = outcomes.filter((o) => o.outcome !== "LANDED");
console.log(`\n${outcomes.length} rows written · ${outcomes.length - failed.length} LANDED · ${failed.length} not LANDED · ${drift} monthly total(s) moved`);
process.exit(failed.length === 0 && drift === 0 && before.length === after.length ? 0 : 1);

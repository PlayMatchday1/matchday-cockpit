// READ-ONLY. Is the per-user promo cap enforced, or advisory?
// No promo endpoint is called with a body; nothing is written; Stripe is not touched.
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/probe-promo-cap-enforcement.ts
import { readFileSync } from "node:fs";
for (const l of readFileSync("/Users/ryanmancuso/Code/matchday-cockpit/.env.local", "utf8").split("\n")) {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
import { createClient } from "@supabase/supabase-js";
import { apiGet } from "../src/lib/matchdayStageApi";
import { isFakePlayerEmail } from "../src/lib/mdapiFakePlayer";

const STAFF_CODE_IDS = new Set([104]); // promo 104 is a staff comp mechanism, explained

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  // 1 — every redemption
  const rows: { user_id: number | null; promocode_id: number; user_email: string | null; amount: number | null }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("mdapi_match_players")
      .select("user_id,promocode_id,user_email,amount,user_is_fake_player")
      .not("promocode_id", "is", null).range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []) as never[]);
    if (!data || data.length < 1000) break;
  }
  console.log(`redemptions: ${rows.length}`);

  // 2 — STAFF / TEST exclusion. @playmatchday.com is staff; the fake-player tail is synthetic.
  const isStaff = (r: { user_email: string | null; user_is_fake_player?: boolean | null }) =>
    !!r.user_email && (/@playmatchday\.com$/i.test(r.user_email) || isFakePlayerEmail(r.user_email))
    || r.user_is_fake_player === true;
  const real = rows.filter((r) => !isStaff(r as never) && !STAFF_CODE_IDS.has(r.promocode_id));
  console.log(`  staff/fake rows excluded: ${rows.length - real.length}`);
  console.log(`  real-player redemptions : ${real.length}`);

  // 3 — every code's cap, from the LIST payload (numberOfUsesPerUser is on the list row, so no N+1)
  const caps = new Map<number, { code: string; cap: number; scope: string; type: string; value: number }>();
  for (let page = 1; page <= 80; page++) {
    const r = await apiGet<{ data?: Record<string, unknown>[] }>("production", "/api/v1/admin/promocodes", { limit: 100, page });
    const list = (Array.isArray(r) ? r : (r.data ?? [])) as Record<string, unknown>[];
    if (!list.length) break;
    for (const p of list) caps.set(Number(p.id), {
      code: String(p.code), cap: Number(p.numberOfUsesPerUser) || 0,
      scope: String(p.targetMatchType), type: String(p.discountType), value: Number(p.discountValue) || 0,
    });
  }
  console.log(`  promo caps loaded: ${caps.size}`);

  // 4 — per (code, user) counts vs the code's OWN cap.
  //     numberOfUsesPerUser is PER-USER except when targetMatchType is TOTAL_USAGE, where it is a
  //     TOTAL. Only the per-user codes answer "is the per-user cap enforced".
  const byCodeUser = new Map<string, number>();
  for (const r of real) {
    if (r.user_id == null) continue;
    const k = `${r.promocode_id}|${r.user_id}`;
    byCodeUser.set(k, (byCodeUser.get(k) ?? 0) + 1);
  }
  const offenders: { codeId: number; code: string; cap: number; userId: number; uses: number; scope: string; type: string; value: number }[] = [];
  for (const [k, uses] of byCodeUser) {
    const [cid, uid] = k.split("|").map(Number);
    const c = caps.get(cid);
    if (!c || c.cap <= 0 || c.cap >= 10000) continue;      // >=10000 is the documented no-cap sentinel
    if (c.scope === "TOTAL_USAGE") continue;               // that cap is a TOTAL, not per-user
    if (uses > c.cap) offenders.push({ codeId: cid, code: c.code, cap: c.cap, userId: uid, uses, scope: c.scope, type: c.type, value: c.value });
  }
  const codes = new Set(offenders.map((o) => o.codeId));
  const players = new Set(offenders.map((o) => o.userId));
  console.log(`\n──────── PER-USER CAP, REAL PLAYERS ONLY ────────`);
  console.log(`codes with a real player OVER the code's own per-user cap: ${codes.size}`);
  console.log(`distinct real players over a cap                        : ${players.size}`);
  console.log(`(code,player) pairs over cap                            : ${offenders.length}`);
  const worst = offenders.sort((a, b) => (b.uses - b.cap) - (a.uses - a.cap) || b.uses - a.uses).slice(0, 10);
  console.log(`\nworst cases (by how far over):`);
  for (const o of worst) console.log(`  ${o.code} (id ${o.codeId}) cap ${o.cap} — player ${o.userId} used it ${o.uses}x  [${o.type} ${o.value}, ${o.scope}]`);

  // 5 — THE QUESTION UNDERNEATH: is the cap enforced at all?
  const perUserCoded = [...caps.values()].filter((c) => c.cap > 0 && c.cap < 10000 && c.scope !== "TOTAL_USAGE").length;
  const redeemedPerUserCodes = new Set(real.map((r) => r.promocode_id).filter((id) => {
    const c = caps.get(id); return c && c.cap > 0 && c.cap < 10000 && c.scope !== "TOTAL_USAGE";
  }));
  console.log(`\n──────── IS THE CAP ENFORCED? ────────`);
  console.log(`codes carrying a real per-user cap        : ${perUserCoded}`);
  console.log(`...of those, redeemed at least once      : ${redeemedPerUserCodes.size}`);
  console.log(`...of those, breached by a real player   : ${codes.size}  (${redeemedPerUserCodes.size ? ((codes.size / redeemedPerUserCodes.size) * 100).toFixed(1) : 0}%)`);
  const maxOver = offenders.length ? Math.max(...offenders.map((o) => o.uses - o.cap)) : 0;
  console.log(`worst overage on a single (code,player)  : +${maxOver} beyond the cap`);

  // ── WHAT THE UNENFORCED CAP COST ────────────────────────────────────────────────────────────
  // EXCESS = redemptions beyond each code's own per-user cap. Valued at the MATCH's own price and
  // the CODE's own discount, not a flat assumption: a 50%-off code on a $12 match is $6, not $15.
  const excessPairs = offenders.map((o) => ({ ...o, excess: o.uses - o.cap }));
  const totalExcess = excessPairs.reduce((s2, o) => s2 + o.excess, 0);
  console.log(`\n──────── WHAT IT COST ────────`);
  console.log(`EXCESS redemptions beyond cap (real players): ${totalExcess}`);

  // price each excess redemption. Take that (code,player)'s OWN rows, newest first, and value the
  // ones beyond the cap.
  const rowsByPair = new Map<string, { amount: number | null; match: number | null }[]>();
  for (let from = 0; ; from += 1000) {
    const { data } = await sb.from("mdapi_match_players")
      .select("user_id,promocode_id,amount,match_api_id,user_email,user_is_fake_player")
      .not("promocode_id", "is", null).range(from, from + 999);
    if (!data?.length) break;
    for (const r of data) {
      if (isStaff(r as never) || STAFF_CODE_IDS.has(r.promocode_id as number) || r.user_id == null) continue;
      const k = `${r.promocode_id}|${r.user_id}`;
      if (!rowsByPair.has(k)) rowsByPair.set(k, []);
      rowsByPair.get(k)!.push({ amount: r.amount as number, match: r.match_api_id as number });
    }
    if (data.length < 1000) break;
  }
  // the match's own price, for a 100% code where amount is 0
  const matchIds = [...new Set([...rowsByPair.values()].flat().map((x) => x.match).filter((x): x is number => x != null))];
  const price = new Map<number, number>();
  for (let i = 0; i < matchIds.length; i += 500) {
    const { data } = await sb.from("mdapi_matches").select("api_id,registration_price").in("api_id", matchIds.slice(i, i + 500));
    for (const m of data ?? []) price.set(m.api_id as number, Number(m.registration_price) || 0);
  }
  let worthCents = 0, valued = 0, unpriced = 0;
  for (const o of excessPairs) {
    const rs = rowsByPair.get(`${o.codeId}|${o.userId}`) ?? [];
    const beyond = rs.slice(0, o.excess);   // the excess redemptions
    for (const r of beyond) {
      const face = price.get(r.match ?? -1) ?? 0;
      // A 100%-off spot has amount 0 — its COST is the match's full price (a free spot given away).
      // A partial discount cost the difference between the face price and what was actually paid.
      const paid = Number(r.amount) || 0;
      const cost = o.type === "PERCENT" && o.value >= 100 ? face : Math.max(0, face - paid);
      if (face > 0) valued++; else unpriced++;
      worthCents += cost;
    }
  }
  console.log(`  priced against the match's own registration_price: ${valued} (unpriced: ${unpriced})`);
  console.log(`  VALUE OF THE EXCESS: $${(worthCents / 100).toFixed(2)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });

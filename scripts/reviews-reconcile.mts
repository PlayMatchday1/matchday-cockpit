// Reviews page reconciliation (6b) + fake-filter proof (6c). Throwaway.
// Independently recomputes the tiles, ranked/unranked/unattributed counts, the
// 8-week aggregates and the comment counts straight from mdapi_reviews, and
// compares them to what the page RENDERS. Reuses only normalizeCity for
// row-set parity (the page drops cities the cockpit has no infra for); every
// aggregate below is a fresh independent implementation, NOT the page's derive.
//
// Run: npx --yes tsx --env-file=.env.local scripts/reviews-reconcile.ts

import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { normalizeCity } from "../src/lib/cityMap";

const BASE = "http://localhost:3000";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const svc = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const anon = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const ref = url.replace("https://", "").split(".")[0];
const sb = createClient(url, svc, { auth: { persistSession: false } });

const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: "rmancuso@playmatchday.com" });
const cli = createClient(url, anon, { auth: { persistSession: false } });
const { data: sess } = await cli.auth.verifyOtp({ type: "email", token_hash: link!.properties.hashed_token });

// ---- ingest exactly like useReviewData ----
function parseLocal(s: string | null): Date | null {
  if (!s) return null;
  const p = s.slice(0, 16).split(/[- T:]/).map(Number);
  if (p.length < 5 || p.some((n) => Number.isNaN(n))) return null;
  return new Date(p[0], p[1] - 1, p[2], p[3], p[4]);
}
async function pageAll<T>(table: string, cols: string, tweak?: (q: any) => any): Promise<T[]> {
  const out: T[] = [];
  let from = 0;
  for (;;) {
    let q = sb.from(table).select(cols).range(from, from + 999);
    if (tweak) q = tweak(q);
    const { data, error } = await q;
    if (error || !data) break;
    out.push(...(data as T[]));
    if (data.length < 1000) break;
    from += 1000;
  }
  return out;
}

type Raw = { api_id: number; city_name: string | null; field_title: string | null; manager_first_name: string | null; manager_last_name: string | null; star_rating: number | null; start_date: string | null; user_id: number | null; user_email: string | null; comment: string | null };
type Row = { apiId: number; city: string; field: string; mFirst: string | null; mLast: string | null; star: number; start: Date; userId: string | null; email: string | null; comment: string | null };

const rawReviews = await pageAll<Raw>("mdapi_reviews", "api_id, city_name, field_title, manager_first_name, manager_last_name, star_rating, start_date, user_id, user_email, comment");
const fakeUserRows = await pageAll<{ id: number }>("mdapi_users", "id", (q) => q.eq("is_fake_player", true));
const fakeIds = new Set(fakeUserRows.map((r) => String(r.id)));
const isFakeEmail = (e: string | null) => !!e && /@matchday\.com$/i.test(e);

// same drops as useReviewData, then the fake choke point
const allRows: Row[] = [];
let droppedCity = 0;
for (const r of rawReviews) {
  const start = parseLocal(r.start_date);
  if (!start || r.star_rating == null) continue;
  const city = normalizeCity(r.city_name);
  if (!city) { droppedCity++; continue; }
  allRows.push({ apiId: r.api_id, city, field: r.field_title ?? "", mFirst: r.manager_first_name, mLast: r.manager_last_name, star: Number(r.star_rating), start, userId: r.user_id != null ? String(r.user_id) : null, email: r.user_email, comment: r.comment });
}
const rows = allRows.filter((r) => !((r.userId && fakeIds.has(r.userId)) || isFakeEmail(r.email)));

// ---- 6c: fake filter proof ----
console.log("=== 6c · fake-player filter ===");
const avg = (a: Row[]) => a.reduce((s, r) => s + r.star, 0) / a.length;
console.log(`reviews avg WITHOUT fake filter: ${avg(allRows).toFixed(4)} (n=${allRows.length})`);
console.log(`reviews avg WITH    fake filter: ${avg(rows).toFixed(4)} (n=${rows.length})`);
console.log(`reviews excluded as fake: ${allRows.length - rows.length} (${(((allRows.length - rows.length) / allRows.length) * 100).toFixed(2)}%) — fakes don't leave reviews`);
const mpTotal = (await sb.from("mdapi_match_players").select("*", { count: "exact", head: true })).count!;
const mpFake = (await sb.from("mdapi_match_players").select("*", { count: "exact", head: true }).or("user_is_fake_player.eq.true,user_email.ilike.%@matchday.com")).count!;
console.log(`PROOF the filter mechanism bites where fakes DO live — mdapi_match_players: ${mpFake}/${mpTotal} fake = ${((mpFake / mpTotal) * 100).toFixed(1)}% (the spec's ~15%)`);
console.log(`(cities dropped by normalizeCity: ${droppedCity})`);

// ---- independent aggregation ----
const mkey = (r: Row) => (r.mFirst?.trim() ? `${r.mFirst.trim()}|${(r.mLast ?? "").trim()}` : "");
const mname = (r: Row) => (r.mFirst?.trim() ? `${r.mFirst.trim()}${r.mLast?.trim() ? " " + r.mLast.trim() : ""}` : "");
const matchKey = (r: Row) => `${r.field}@@${r.start.getTime()}`;
const monthKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

function aggMonth(month: string) {
  const f = rows.filter((r) => monthKey(r.start) === month);
  const byMgr = new Map<string, { n: number; s: number; matches: Set<string> }>();
  for (const r of f) {
    const k = mkey(r);
    const g = byMgr.get(k) ?? { n: 0, s: 0, matches: new Set<string>() };
    g.n++; g.s += r.star; g.matches.add(matchKey(r));
    byMgr.set(k, g);
  }
  const managers = [...byMgr.entries()].filter(([k]) => k).map(([, g]) => ({ n: g.n, avg: g.s / g.n }));
  const ranked = managers.filter((m) => m.n >= 10);
  const unranked = managers.filter((m) => m.n < 10);
  const unattr = byMgr.has("") ? 1 : 0;
  const byMatch = new Map<string, { n: number; s: number }>();
  for (const r of f) { const k = matchKey(r); const g = byMatch.get(k) ?? { n: 0, s: 0 }; g.n++; g.s += r.star; byMatch.set(k, g); }
  const matchAgg = [...byMatch.values()].map((g) => ({ n: g.n, avg: g.s / g.n }));
  const attn = matchAgg.filter((m) => m.avg < 3.5 && m.n >= 3).length;
  const stand = matchAgg.filter((m) => m.avg >= 4.8 && m.n >= 3).length;
  return { avg: f.length ? f.reduce((s, r) => s + r.star, 0) / f.length : null, reviews: f.length, matches: byMatch.size, ranked: ranked.length, unranked: unranked.length, unattr, attn, stand };
}

const months = [...new Set(rows.map((r) => monthKey(r.start)))].sort().reverse();
const defaultMonth = months[0];

// 8-week (global)
const NOW = new Date();
function monday(d: Date) { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }
const curMon = monday(NOW);
const wStart = new Date(curMon.getFullYear(), curMon.getMonth(), curMon.getDate() - 7 * 7).getTime();
const wEnd = curMon.getTime() + 7 * 86400000;
let wSum = 0, wVol = 0;
for (const r of rows) { const t = r.start.getTime(); if (t >= wStart && t < wEnd) { wSum += r.star; wVol++; } }
const wavg = wVol ? wSum / wVol : 0;

// comments (this week window, no page filters)
function commentsWeek() {
  const today = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate());
  const a = monday(today); const b = new Date(a.getFullYear(), a.getMonth(), a.getDate() + 6);
  const inc = rows.filter((r) => { const d = new Date(r.start.getFullYear(), r.start.getMonth(), r.start.getDate()); if (d < a || d > b) return false; return (r.comment && r.comment.trim()) || r.star === 1; });
  return { all: inc.length, needs: inc.filter((r) => r.star <= 3).length, praise: inc.filter((r) => r.star === 5).length };
}
const cw = commentsWeek();

// ---- read rendered ----
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await ctx.addInitScript(([k, v]) => { try { localStorage.setItem(k as string, v as string); } catch {} }, [`sb-${ref}-auth-token`, JSON.stringify(sess!.session)]);
const pg = await ctx.newPage();
await pg.goto(BASE + "/match-ops/reviews", { waitUntil: "load", timeout: 60000 });
await pg.waitForTimeout(5000);

const readMonth = async () => pg.evaluate(() => ({
  avg: (document.querySelector('[data-rv="avg"]')?.textContent || "").replace(/,/g, "") || null,
  volume: (document.querySelector('[data-rv="volume"]')?.textContent || "").replace(/,/g, "") || null,
  attn: (document.querySelector('[data-rv="attn"]')?.textContent || "").replace(/,/g, "") || null,
  stand: (document.querySelector('[data-rv="stand"]')?.textContent || "").replace(/,/g, "") || null,
  ranked: document.querySelectorAll('[data-rv="ranked-row"]').length,
  unranked: document.querySelectorAll('[data-rv="unranked-row"]').length,
  unattr: document.querySelectorAll('[data-rv="unattr-row"]').length,
}));
const renderedAug = await readMonth();
const strip = await pg.evaluate(() => ({
  wavg: (document.querySelector('[data-rv="wavg"]')?.textContent || "").trim(),
  totvol: (document.querySelector('[data-rv="totvol"]')?.textContent || "").replace(/,/g, ""),
}));
const sev = await pg.evaluate(() => ({
  all: ((document.querySelector('[data-rv="sev-all"]')?.textContent || "").match(/(\d+)\s*$/) || [])[1] || null,
  needs: ((document.querySelector('[data-rv="sev-needs"]')?.textContent || "").match(/(\d+)\s*$/) || [])[1] || null,
  praise: ((document.querySelector('[data-rv="sev-praise"]')?.textContent || "").match(/(\d+)\s*$/) || [])[1] || null,
}));
// switch to a full month (Jul 2026) via the month select for a data-rich check
const monthSel = pg.locator("select").first();
const julVal = months.find((m) => m.endsWith("-07")) ?? months[months.length - 1];
await monthSel.selectOption(julVal);
await pg.waitForTimeout(1500);
const renderedJul = await readMonth();

await browser.close();

// ---- compare ----
const rows2 = (label: string, exp: any, got: any) => {
  const ok = String(exp) === String(got);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(26)} expected=${exp}  rendered=${got}`);
  return ok;
};
let fails = 0;
const chk = (l: string, e: any, g: any) => { if (!rows2(l, e, g)) fails++; };

const expAug = aggMonth(defaultMonth);
console.log(`\n=== 6b · reconcile — DEFAULT month ${defaultMonth} (independent vs rendered) ===`);
chk("avg rating", expAug.avg == null ? "—" : expAug.avg.toFixed(2), renderedAug.avg);
chk("review volume", expAug.reviews, renderedAug.volume);
chk("needs attention", expAug.attn, renderedAug.attn);
chk("standouts", expAug.stand, renderedAug.stand);
chk("ranked rows", expAug.ranked, renderedAug.ranked);
chk("unranked rows", expAug.unranked, renderedAug.unranked);
chk("unattributed rows", expAug.unattr, renderedAug.unattr);

console.log(`\n=== 6b · reconcile — FULL month ${julVal} ===`);
const expJul = aggMonth(julVal);
chk("avg rating", expJul.avg == null ? "—" : expJul.avg.toFixed(2), renderedJul.avg);
chk("review volume", expJul.reviews, renderedJul.volume);
chk("needs attention", expJul.attn, renderedJul.attn);
chk("standouts", expJul.stand, renderedJul.stand);
chk("ranked rows", expJul.ranked, renderedJul.ranked);
chk("unranked rows", expJul.unranked, renderedJul.unranked);
chk("unattributed rows", expJul.unattr, renderedJul.unattr);

console.log(`\n=== 6b · reconcile — 8-week strip (global) + comments (this week) ===`);
chk("8wk weighted avg", wavg.toFixed(2), strip.wavg);
chk("8wk total volume", wVol, strip.totvol);
chk("comments · all", cw.all, sev.all);
chk("comments · needs", cw.needs, sev.needs);
chk("comments · praise", cw.praise, sev.praise);

console.log(`\n=== ${fails === 0 ? "ALL RECONCILED" : fails + " MISMATCH(ES)"} ===`);
process.exit(fails ? 1 : 0);

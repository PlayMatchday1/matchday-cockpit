// 0089 apply-verification + reply write-path end-to-end. Throwaway.
// No Postgres/psql/pg access here (only PostgREST + the service key), so every
// declared object is checked BEHAVIOURALLY, not read from pg_catalog — stated
// as such in the output. Run:
//   npx --yes tsx --env-file=.env.local scripts/reviews-migration-verify.mts

import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { normalizeCity } from "../src/lib/cityMap";

const PROD = "https://matchday-clubhouse.vercel.app";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const svc = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const anon = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const ref = url.replace("https://", "").split(".")[0];
const OUT = (process.env.CLAUDE_JOB_DIR || ".") + "/tmp";
const sb = createClient(url, svc, { auth: { persistSession: false } });

const { data: me } = await sb.from("app_users").select("id, full_name").eq("email", "rmancuso@playmatchday.com").single();
const myId = me!.id as string;

async function authedClient(email: string) {
  const { data: l } = await sb.auth.admin.generateLink({ type: "magiclink", email });
  const c = createClient(url, anon, { auth: { persistSession: false } });
  const { data: s } = await c.auth.verifyOtp({ type: "email", token_hash: l!.properties.hashed_token });
  return { c, session: s!.session };
}

const P = (ok: boolean, label: string, detail = "") => console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
let fails = 0;
const chk = (ok: boolean, l: string, d = "") => { if (!ok) fails++; P(ok, l, d); };

console.log("=== 1 · MIGRATION OBJECTS (behavioural — no catalog access) ===");
// columns
const colsSel = await sb.from("review_replies").select("review_id, replied_at, replied_by, created_at, updated_at").limit(0);
chk(!colsSel.error, "table + all 5 declared columns exist", colsSel.error?.message ?? "review_id, replied_at, replied_by, created_at, updated_at");
// count 0
const cnt0 = (await sb.from("review_replies").select("*", { count: "exact", head: true })).count;
chk(cnt0 === 0, "row count == 0", String(cnt0));
// PK on review_id (dup insert rejected)
await sb.from("review_replies").delete().gte("review_id", 999000000); // clean any prior test rows
await sb.from("review_replies").insert({ review_id: 999000001, replied_by: myId });
const dup = await sb.from("review_replies").insert({ review_id: 999000001, replied_by: myId });
chk(!!dup.error && /duplicate|unique|23505/i.test(dup.error.message), "PRIMARY KEY on review_id (dup rejected)", dup.error?.message ?? "no error");
// types: read the row back
const { data: sample } = await sb.from("review_replies").select("*").eq("review_id", 999000001).single();
console.log("     inserted row (types):", JSON.stringify(sample));
// FK replied_by -> app_users (bad uuid rejected)
const fk = await sb.from("review_replies").insert({ review_id: 999000002, replied_by: "00000000-0000-0000-0000-000000000000" });
chk(!!fk.error && /foreign key|violates|23503/i.test(fk.error.message), "FK replied_by -> app_users (bad uuid rejected)", fk.error?.message ?? "no error");
// updated_at trigger (BEFORE UPDATE bumps it) — seed an old updated_at, then update
await sb.from("review_replies").insert({ review_id: 999000003, replied_by: myId, updated_at: "2020-01-01T00:00:00Z" });
const before = (await sb.from("review_replies").select("updated_at").eq("review_id", 999000003).single()).data!.updated_at;
await sb.from("review_replies").update({ replied_by: myId }).eq("review_id", 999000003);
const after = (await sb.from("review_replies").select("updated_at").eq("review_id", 999000003).single()).data!.updated_at;
chk(new Date(after as string).getTime() > new Date(before as string).getTime(), "updated_at trigger fires on UPDATE", `${before} -> ${after}`);
await sb.from("review_replies").delete().gte("review_id", 999000000); // cleanup
console.log("  NOTE: index review_replies_replied_by_idx and policy NAMES/commands cannot be read without pg_catalog access; RLS behaviour is proven in §4.");

console.log("\n=== 4 · RLS GATE (admin allowed, non-admin + anon refused) ===");
const admin = await authedClient("rmancuso@playmatchday.com");
const nonAdmin = await authedClient("info@playmatchday.com");
const anonC = createClient(url, anon, { auth: { persistSession: false } });
// seed a row via service role so SELECT visibility can be tested
await sb.from("review_replies").insert({ review_id: 999000020, replied_by: myId });
// admin can read + write
const aSel = await admin.c.from("review_replies").select("review_id").eq("review_id", 999000020);
chk(!aSel.error && (aSel.data?.length ?? 0) === 1, "admin SELECT sees the row");
const aIns = await admin.c.from("review_replies").insert({ review_id: 999000021, replied_by: myId });
chk(!aIns.error, "admin INSERT allowed", aIns.error?.message ?? "ok");
const aDel = await admin.c.from("review_replies").delete().eq("review_id", 999000021);
chk(!aDel.error, "admin DELETE allowed");
// non-admin: cannot see, cannot insert, cannot delete
const nSel = await nonAdmin.c.from("review_replies").select("review_id").eq("review_id", 999000020);
chk((nSel.data?.length ?? 0) === 0, "non-admin SELECT sees nothing (RLS hides)", `rows=${nSel.data?.length ?? 0}`);
const nIns = await nonAdmin.c.from("review_replies").insert({ review_id: 999000022, replied_by: myId });
chk(!!nIns.error, "non-admin INSERT refused", nIns.error?.message ?? "NO ERROR (gate failed!)");
await nonAdmin.c.from("review_replies").delete().eq("review_id", 999000020);
const stillThere = (await sb.from("review_replies").select("review_id").eq("review_id", 999000020)).data?.length;
chk(stillThere === 1, "non-admin DELETE removed nothing (RLS)", `row still present=${stillThere === 1}`);
// anon
const anIns = await anonC.from("review_replies").insert({ review_id: 999000023, replied_by: myId });
chk(!!anIns.error, "anon INSERT refused", anIns.error?.message ?? "NO ERROR (gate failed!)");
await sb.from("review_replies").delete().gte("review_id", 999000000); // cleanup all test rows
console.log("     RLS is ENABLED and enforced: non-admin/anon writes rejected, non-admin cannot read; matches 0089's select/insert/delete admin gate.");

// ---- independent this-week comment counts (for §5 reconcile) ----
function parseLocal(s: string | null): Date | null {
  if (!s) return null;
  const p = s.slice(0, 16).split(/[- T:]/).map(Number);
  if (p.length < 5 || p.some((n) => Number.isNaN(n))) return null;
  return new Date(p[0], p[1] - 1, p[2], p[3], p[4]);
}
async function pageAll<T>(cols: string): Promise<T[]> {
  const out: T[] = []; let from = 0;
  for (;;) { const { data, error } = await sb.from("mdapi_reviews").select(cols).range(from, from + 999); if (error || !data) break; out.push(...(data as T[])); if (data.length < 1000) break; from += 1000; }
  return out;
}
const raw = await pageAll<any>("api_id, city_name, field_title, star_rating, start_date, user_id, user_email, comment");
const fakeIdRows: { id: number }[] = [];
{ let from = 0; for (;;) { const { data } = await sb.from("mdapi_users").select("id").eq("is_fake_player", true).range(from, from + 999); if (!data) break; fakeIdRows.push(...data); if (data.length < 1000) break; from += 1000; } }
const fakeIds = new Set(fakeIdRows.map((r) => String(r.id)));
const clean = raw.map((r) => ({ apiId: r.api_id as number, city: normalizeCity(r.city_name), star: r.star_rating == null ? null : Number(r.star_rating), start: parseLocal(r.start_date), userId: r.user_id != null ? String(r.user_id) : null, email: r.user_email as string | null, comment: r.comment as string | null }))
  .filter((r) => r.start && r.star != null && r.city && !((r.userId && fakeIds.has(r.userId)) || /@matchday\.com$/i.test(r.email ?? "")));
function thisWeek() {
  const now = new Date(); const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const a = new Date(today); a.setDate(a.getDate() - ((a.getDay() + 6) % 7)); const b = new Date(a.getFullYear(), a.getMonth(), a.getDate() + 6);
  return clean.filter((r) => { const d = new Date(r.start!.getFullYear(), r.start!.getMonth(), r.start!.getDate()); return d >= a && d <= b; });
}
async function counts() {
  const inWin = thisWeek().filter((r) => (r.comment && r.comment.trim()) || r.star === 1);
  const replied = new Set(((await sb.from("review_replies").select("review_id")).data ?? []).map((x) => Number(x.review_id)));
  return { all: inWin.length, needs: inWin.filter((r) => r.star! <= 3).length, praise: inWin.filter((r) => r.star === 5).length, unanswered: inWin.filter((r) => r.star! <= 3 && !replied.has(r.apiId)).length };
}
const beforeCounts = await counts();
console.log("\n=== 5 · reconcile BEFORE (review_replies empty) ===", JSON.stringify(beforeCounts));

// ---- 2 + 3 · UI write path on PROD ----
console.log("\n=== 2/3 · PROD write path ===");
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await ctx.addInitScript(([k, v]) => { try { localStorage.setItem(k as string, v as string); } catch {} }, [`sb-${ref}-auth-token`, JSON.stringify(admin.session)]);
const pg = await ctx.newPage();
await pg.goto(PROD + "/match-ops/reviews", { waitUntil: "load", timeout: 60000 });
await pg.waitForTimeout(5500);
const degradeGone = !(await pg.locator("text=/Reply tracking not enabled yet/").isVisible().catch(() => false));
chk(degradeGone, "degrade note is GONE (out of degrade mode)");
await pg.locator('[data-rv="sev-open"]').click();
await pg.waitForTimeout(1200);
const unansweredBeforeUI = Number(((await pg.locator('[data-rv="sev-open"]').textContent()) || "").match(/(\d+)\s*$/)?.[1] ?? "-1");
const firstTick = pg.locator('.rv-ctab tbody tr button').filter({ hasText: /Reply due/ }).first();
const tickEnabled = await firstTick.isEnabled().catch(() => false);
chk(tickEnabled, "tick column is interactive");
await pg.screenshot({ path: `${OUT}/rv_v_live.png` });
await firstTick.click();
await pg.waitForTimeout(1800);

// the one real row now
const wrote = (await sb.from("review_replies").select("review_id, replied_at, replied_by")).data ?? [];
console.log("  review_replies after tick:", JSON.stringify(wrote));
chk(wrote.length === 1, "exactly one reply row written");
const row = wrote[0];
const { data: byUser } = await sb.from("app_users").select("full_name, email").eq("id", row.replied_by).single();
chk(!!byUser && row.replied_by === myId, "replied_by resolves to my app_users row (not null/raw uuid)", byUser ? `${byUser.full_name} <${byUser.email}>` : "unresolved");
const { data: rev } = await sb.from("mdapi_reviews").select("star_rating, user_first_name, user_last_name, manager_first_name, field_title").eq("api_id", row.review_id).single();
console.log("  ticked review:", JSON.stringify(rev));

// reload → survives? stamp renders? sorts out of Unanswered?
await pg.reload({ waitUntil: "load" }); await pg.waitForTimeout(5000);
const stillWritten = ((await sb.from("review_replies").select("review_id")).data ?? []).length === 1;
chk(stillWritten, "tick survived reload #1 (row still in DB)");
await pg.locator('[data-rv="sev-open"]').click(); await pg.waitForTimeout(1000);
const unansweredAfterUI = Number(((await pg.locator('[data-rv="sev-open"]').textContent()) || "").match(/(\d+)\s*$/)?.[1] ?? "-1");
chk(unansweredAfterUI === unansweredBeforeUI - 1, "Unanswered dropped by exactly 1 in UI", `${unansweredBeforeUI} -> ${unansweredAfterUI}`);
// find the replied row (switch to Needs a reply) + read stamp
await pg.locator('[data-rv="sev-needs"]').click(); await pg.waitForTimeout(1000);
const repliedBtn = pg.locator('.rv-ctab tbody tr').filter({ has: pg.locator('button:has-text("Replied")') }).first();
const stamp = await repliedBtn.locator("div").filter({ hasText: new RegExp(myName()) }).first().textContent().catch(() => null);
function myName() { return (me!.full_name as string).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
chk(!!stamp, "who/when stamp renders on the ticked row", stamp ?? "not found");
await pg.screenshot({ path: `${OUT}/rv_v_ticked.png` });

const afterCounts = await counts();
console.log("=== 5 · reconcile AFTER (one reply recorded) ===", JSON.stringify(afterCounts));
chk(afterCounts.unanswered === beforeCounts.unanswered - 1, "independent Unanswered dropped by exactly 1", `${beforeCounts.unanswered} -> ${afterCounts.unanswered}`);
chk(afterCounts.all === beforeCounts.all && afterCounts.needs === beforeCounts.needs && afterCounts.praise === beforeCounts.praise, "all / needs / praise unchanged", `all ${afterCounts.all}, needs ${afterCounts.needs}, praise ${afterCounts.praise}`);

// untick via UI
await repliedBtn.locator('button:has-text("Replied")').click();
await pg.waitForTimeout(1800);
const afterUntick = ((await sb.from("review_replies").select("review_id")).data ?? []).length;
chk(afterUntick === 0, "untick deleted the row", `rows=${afterUntick}`);
await pg.reload({ waitUntil: "load" }); await pg.waitForTimeout(5000);
const afterUntickReload = ((await sb.from("review_replies").select("review_id")).data ?? []).length;
chk(afterUntickReload === 0, "untick survived reload #2");
await pg.locator('[data-rv="sev-open"]').click(); await pg.waitForTimeout(1000);
const unansweredBack = Number(((await pg.locator('[data-rv="sev-open"]').textContent()) || "").match(/(\d+)\s*$/)?.[1] ?? "-1");
chk(unansweredBack === unansweredBeforeUI, "review returned to Unanswered after untick", `${unansweredAfterUI} -> ${unansweredBack}`);
await pg.screenshot({ path: `${OUT}/rv_v_unticked.png` });

await browser.close();
// final safety: ensure no test rows remain
await sb.from("review_replies").delete().gte("review_id", 999000000);
const finalCount = (await sb.from("review_replies").select("*", { count: "exact", head: true })).count;
console.log(`\nfinal review_replies row count: ${finalCount} (clean)`);
console.log(`\n=== ${fails === 0 ? "ALL VERIFIED" : fails + " FAILURE(S)"} ===`);
process.exit(fails ? 1 : 0);

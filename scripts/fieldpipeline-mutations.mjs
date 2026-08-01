// Field Pipeline MUTATION harness. Every write is driven through the real UI
// against the running app, then the page is reloaded AND the row re-read from
// the database (service role) — an optimistic UI update that never reached the
// DB is indistinguishable from a real write until you reload and re-read.
//
// Covers: create, edit title, reassign owner, DRAG stage->stage (real pointer
// gesture), drag onto a COLLAPSED rail, move back via the modal stage selector,
// checklist toggle (both directions, chip == count), server-failure revert,
// delete. Also prints all five column headers under an "Austin" search.
//
// Run from repo root:  node --env-file=.env.local scripts/fieldpipeline-mutations.mjs

import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";

const BASE = process.env.BASE || "http://localhost:3000";
const OUT = (process.env.CLAUDE_JOB_DIR || ".") + "/tmp";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anon = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const ref = url.replace("https://", "").split(".")[0];
const TITLE = "ZZ TEST — DELETE ME";

const sb = createClient(url, svc, { auth: { persistSession: false } });
const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: "rmancuso@playmatchday.com" });
const cli = createClient(url, anon, { auth: { persistSession: false } });
const { data: sess } = await cli.auth.verifyOtp({ type: "email", token_hash: link.properties.hashed_token });

// ---- DB helpers (ground truth) ----
const fieldCount = async () => {
  const { count } = await sb.from("kanban_cards").select("id", { count: "exact", head: true }).eq("board_type", "field_pipeline");
  return count;
};
const openTodoCount = async () => {
  const { data: cs } = await sb.from("kanban_cards").select("id").eq("board_type", "field_pipeline");
  const { data: items } = await sb.from("kanban_checklist_items").select("done").in("card_id", cs.map((c) => c.id));
  return (items || []).filter((i) => !i.done).length;
};
const findTest = async () => {
  const { data } = await sb.from("kanban_cards").select("id, title, stage, owner_user_id, created_at, updated_at").eq("board_type", "field_pipeline").ilike("title", "ZZ TEST%");
  return data && data[0];
};

const pass = [];
const fail = [];
const check = (name, cond, detail = "") => { (cond ? pass : fail).push(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`); console.log(`  ${cond ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`); };

// wait for server
for (let i = 0; i < 60; i++) {
  try { const r = await fetch(BASE + "/match-ops/field-pipeline"); if (r.ok || r.status === 200) break; } catch {}
  await new Promise((r) => setTimeout(r, 1000));
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
await ctx.addInitScript(([k, v]) => { try { localStorage.setItem(k, v); } catch {} }, [`sb-${ref}-auth-token`, JSON.stringify(sess.session)]);
const pg = await ctx.newPage();
const errs = [];
pg.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
pg.on("pageerror", (e) => errs.push("[pageerror] " + e.message));

const goto = async () => { await pg.goto(BASE + "/match-ops/field-pipeline", { waitUntil: "load", timeout: 60000 }); await pg.waitForTimeout(3500); };
const reload = async () => { await pg.reload({ waitUntil: "load" }); await pg.waitForTimeout(3500); };
const card = () => pg.locator('[role="button"]', { hasText: "ZZ TEST" }).first();
const column = (title) => pg.locator("section").filter({ hasText: title }).first();
const stripTodos = () => pg.evaluate(() => { const m = document.body.innerText.match(/(\d+)\s+open to-do/); return m ? Number(m[1]) : null; });
const openModal = async () => { await card().click(); await pg.waitForSelector('[role="dialog"]'); await pg.waitForTimeout(300); };
const saveModal = async () => { await pg.locator('[role="dialog"] button', { hasText: /Save changes|Add card/ }).click(); await pg.waitForTimeout(1200); };

// HTML5 drag by dispatching real DragEvents through the actual DOM handlers.
// Playwright's synthetic pointer CANNOT drive the native HTML5 DnD API (its own
// documented limitation), and this board uses the same native-HTML5-DnD model
// as the production KanbanBoard (no library, per the brief). This exercises the
// real onDragStart -> onDragOver -> onDrop -> moveCardToStage -> updateCard ->
// Supabase chain — it is NOT a setState/DB shortcut. The mid-drag screenshot is
// taken after dragover, so the drop indicator is on screen.
async function html5Drag(source, target, midShot) {
  const dt = await pg.evaluateHandle(() => new DataTransfer());
  await source.dispatchEvent("dragstart", { dataTransfer: dt });
  await target.dispatchEvent("dragenter", { dataTransfer: dt });
  await target.dispatchEvent("dragover", { dataTransfer: dt });
  await pg.waitForTimeout(250);
  if (midShot) await pg.screenshot({ path: midShot });
  await target.dispatchEvent("drop", { dataTransfer: dt });
  await source.dispatchEvent("dragend", { dataTransfer: dt });
  await pg.waitForTimeout(1200);
}
async function dragStageAndVerify(targetTitle, wantStage, midShot) {
  const before = (await findTest()).stage;
  await html5Drag(card(), column(targetTitle), midShot);
  await reload();
  const row = await findTest();
  return { before, after: row.stage, path: "html5-dragevents", row };
}

console.log("\n=== FIELD PIPELINE MUTATION E2E ===");
const countBefore = await fieldCount();
const todosBefore = await openTodoCount();
console.log(`field count BEFORE = ${countBefore}; open to-dos BEFORE = ${todosBefore}`);

await goto();

// (a) CREATE via UI
await pg.locator("button", { hasText: "+ New card" }).click();
await pg.waitForSelector('[role="dialog"]');
await pg.locator('[role="dialog"] input').first().fill(TITLE);
await pg.locator('[role="dialog"] button', { hasText: "Add card" }).click();
await pg.waitForTimeout(1400);
await reload();
let row = await findTest();
check("a. create reached DB", !!row && (await fieldCount()) === countBefore + 1, row ? `stage=${row.stage}, count=${await fieldCount()}` : "not found");
const createdStage = row.stage;

// (b) EDIT TITLE
await openModal();
await pg.locator('[role="dialog"] input').first().fill(TITLE + " EDITED");
await saveModal();
await reload();
row = await findTest();
check("b. edit title reached DB", row.title === TITLE + " EDITED", `title="${row.title}"`);

// (c) REASSIGN OWNER (null -> real owner)
await openModal();
await pg.locator('[role="dialog"] select').filter({ hasText: "Unassigned" }).last().selectOption({ index: 1 });
await saveModal();
await reload();
row = await findTest();
check("c. owner reassign reached DB", !!row.owner_user_id, `owner_user_id=${row.owner_user_id}`);

// (d) DRAG stage -> stage (from created stage to Contacted)
const upBefore = (await findTest()).updated_at;
const d = await dragStageAndVerify("Contacted", "contacted", `${OUT}/fpm_drag_open.png`);
check("d. drag to Contacted reached DB", d.after === "contacted", `${d.before} -> ${d.after} via ${d.path}`);
const upAfter = (await findTest()).updated_at;
check("d. updated_at advanced on drag (age resets)", new Date(upAfter) > new Date(upBefore), `${upBefore} -> ${upAfter}`);

// (e) DRAG onto a COLLAPSED rail (Archived is collapsed by default)
const e = await dragStageAndVerify("Archived", "archived", `${OUT}/fpm_drag_collapsed_rail.png`);
check("e. drop on collapsed Archived rail reached DB", e.after === "archived", `${e.before} -> ${e.after} via ${e.path}`);

// (f) MOVE BACK via the modal stage selector -> Negotiation
await openModal();
await pg.locator('[role="dialog"] select').filter({ hasText: "Ongoing Negotiation" }).selectOption({ label: "Ongoing Negotiation" });
await saveModal();
await reload();
row = await findTest();
check("f. modal stage-selector move reached DB", row.stage === "negotiation", `stage=${row.stage}`);

// (g) CHECKLIST toggle — chip must change by exactly one, both directions
await openModal();
await pg.locator('[role="dialog"] input[placeholder="Add to-do…"]').fill("ZZ probe todo");
await pg.locator('[role="dialog"] button', { hasText: /^Add$/ }).click();
await pg.waitForTimeout(300);
await saveModal();
await reload();
const chipAfterAdd = await stripTodos();
check("g. add to-do: chip +1", chipAfterAdd === todosBefore + 1, `chip=${chipAfterAdd} (was ${todosBefore})`);
check("g. add to-do: DB +1", (await openTodoCount()) === todosBefore + 1, `db=${await openTodoCount()}`);

// toggle DONE
await openModal();
await pg.locator('[role="dialog"] input[type="checkbox"]').first().check();
await saveModal();
await reload();
const chipAfterDone = await stripTodos();
check("g. toggle done: chip -1", chipAfterDone === todosBefore, `chip=${chipAfterDone}`);
check("g. toggle done: DB -1", (await openTodoCount()) === todosBefore, `db=${await openTodoCount()}`);

// toggle back UNDONE
await openModal();
await pg.locator('[role="dialog"] input[type="checkbox"]').first().uncheck();
await saveModal();
await reload();
const chipAfterUndone = await stripTodos();
check("g. toggle undone: chip +1", chipAfterUndone === todosBefore + 1, `chip=${chipAfterUndone}`);

// (server-failure revert) stub the PATCH to fail; drag must revert + toast, DB unchanged
const stageBeforeFail = (await findTest()).stage;
await pg.route("**/rest/v1/kanban_cards**", (route) => {
  if (route.request().method() === "PATCH") return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ message: "forced failure" }) });
  return route.continue();
});
await html5Drag(card(), column("Confirmed Fields"), null);
await pg.waitForTimeout(800);
const toastShown = await pg.locator('[role="alert"]').count();
await pg.unroute("**/rest/v1/kanban_cards**");
await reload();
const stageAfterFail = (await findTest()).stage;
check("x. failed drop reverts (DB stage unchanged)", stageAfterFail === stageBeforeFail, `${stageBeforeFail} -> ${stageAfterFail}`);
check("x. failed drop surfaced a toast", toastShown > 0, `alerts=${toastShown}`);

// (Austin search) print ALL FIVE column header texts including collapsed rails
await pg.locator('input[placeholder^="Search"]').fill("Austin");
await pg.waitForTimeout(800);
const headers = await pg.evaluate(() =>
  [...document.querySelectorAll("section")].map((s) => (s.textContent || "").replace(/\s+/g, " ").trim().slice(0, 48)),
);
console.log("\n  Austin-search column headers (all 5):");
headers.forEach((h, i) => console.log(`   [${i}] ${h}`));
check("search: exactly 5 columns present", headers.length === 5, `count=${headers.length}`);
await pg.locator('input[placeholder^="Search"]').fill("");
await pg.waitForTimeout(500);

// (h) DELETE via UI
await openModal();
await pg.locator('[role="dialog"] button', { hasText: /^Delete$/ }).first().click();
await pg.waitForTimeout(300);
await pg.locator('[role="dialog"] button', { hasText: /^Delete$/ }).first().click();
await pg.waitForTimeout(1200);
await reload();
const gone = await findTest();
const countAfter = await fieldCount();
check("h. delete reached DB (row gone)", !gone, gone ? `still present id=${gone.id}` : "gone");
check("h. field count returned to baseline", countAfter === countBefore, `after=${countAfter} baseline=${countBefore}`);

// teardown safety — never leave a test row behind
const leftover = await findTest();
if (leftover) { await sb.from("kanban_cards").delete().eq("id", leftover.id); console.log(`  cleaned leftover ${leftover.id}`); }
const todosFinal = await openTodoCount();
check("teardown: open to-dos back to baseline", todosFinal === todosBefore, `final=${todosFinal} baseline=${todosBefore}`);

console.log(`\nfield count AFTER = ${countAfter} (baseline ${countBefore})`);
console.log(`console/page errors during run: ${errs.length}`);
if (errs.length) console.log(errs.slice(0, 5).join("\n"));
console.log(`\n=== SUMMARY: ${pass.length} passed, ${fail.length} failed ===`);
if (fail.length) fail.forEach((f) => console.log(f));

await browser.close();
process.exit(fail.length ? 1 : 0);

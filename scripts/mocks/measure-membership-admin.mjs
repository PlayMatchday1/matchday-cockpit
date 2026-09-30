/* Assertions for scripts/mocks/membership-admin.html.
 *
 * Every absence check carries a presence control in the same run, and every zero from a selector
 * written here is checked against its container existing first.
 *
 *   node scripts/mocks/measure-membership-admin.mjs
 */
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const CANDS = [process.env.PW_CHROMIUM, "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"];
const executablePath = CANDS.find(x => x && existsSync(x));
const FILE = "file://" + join(dirname(fileURLToPath(import.meta.url)), "membership-admin.html");
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log("✓ " + m)) : (fail++, console.log("✗ " + m)); };
const D = t => `[data-testid="${t}"]`;

const browser = await chromium.launch(executablePath ? { executablePath } : {});
const p = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
const load = async () => { await p.goto(FILE); await p.waitForTimeout(140); };
const pick = async k => { await p.click(`${D("sw")}[data-k="${k}"]`); await p.waitForTimeout(120); };
const txt = async t => (await p.$$eval(D(t), es => es.map(e => e.textContent).join(" "))) ?? "";
const acts = () => p.$$eval(`${D("acts")} button`, es => es.map(e => e.dataset.testid));
const fact = k => p.$eval(`${D("fact")}[data-k="${k}"] .v`, e => e.textContent.trim());
await load();

// ══ 1. THE ID EVERY WRITE IS KEYED ON IS ON THE PANEL, AND IT IS NOT THE STRIPE ID ════════════
// playerProfile.ts today sets number = stripeSubscriptionId ?? id, so the numeric
// userSubscriptions.id — the path parameter for all three endpoints — never reaches the client.
// Nothing can be built until the profile carries it, so it is asserted first.
ok(await p.$$eval(`${D("fact")}[data-k="MEMBERSHIP ID"]`, es => es.length) === 1,
  "the numeric membership id is on the card");
const memId = await fact("MEMBERSHIP ID"), stripeId = await fact("SUBSCRIPTION");
ok(/^\d+$/.test(memId), `  and it is numeric (${memId})`);
ok(stripeId.startsWith("sub_") && stripeId !== memId,
  `  CONTROL: shown alongside the Stripe id, not instead of it (${stripeId})`);

// ══ 2. A COMP IS NEVER DESCRIBED AS MONEY ═════════════════════════════════════════════════════
// subscribeSpecificUser writes amount = the city plan price and creates NO Stripe subscription.
// So the card would otherwise read "PRICE $49.00" over a member who has never paid a cent.
await pick("comped");
ok(await p.$eval(D("mem-badge"), e => e.textContent).then(t => t.includes("COMPED")),
  "a comped membership says so on the badge");
ok(await p.$$eval(D("comp-note"), es => es.length) === 1, "  and carries the never-been-charged note");
ok((await txt("comp-note")).includes("not money collected") || (await txt("comp-note")).includes("not money"),
  "  which says the price is the plan's worth, not money collected");
ok(await fact("SUBSCRIPTION") === "none in Stripe",
  "  and the Stripe row says there is no subscription rather than showing a blank");
await pick("paid");
ok(await p.$$eval(D("comp-note"), es => es.length) === 0 && await p.$$eval(D("mempanel"), es => es.length) === 1,
  "  CONTROL: a paying member gets no such note, on a panel that did render");

// ══ 3. $0 IS A DIFFERENT THING FROM A COMP, AND BOTH ARE DIFFERENT FROM PAYING ════════════════
await pick("free");
ok(await p.$$eval(D("zero-note"), es => es.length) === 1, "a $0 Stripe subscription is called out separately");
ok((await txt("zero-note")).includes("real Stripe subscription"),
  "  and is named as a real subscription, unlike the comp");
ok((await txt("zero-note")).includes("not count toward paid members"),
  "  with the consequence stated: membershipStats requires price_cents > 0");

// ══ 4. THE SENTENCE THE EXISTING CARD GETS WRONG ══════════════════════════════════════════════
// cancelSubscriptionsForAdmin calls stripe.subscriptions.cancel() — immediate. The player's own
// cancel path sets cancel_at_period_end. The card has ONE sentence for both today, and it is the
// period-end one. Shipping End without splitting it puts a false reassurance on screen.
await pick("selfcancel");
ok(await p.$$eval(D("ended-player"), es => es.length) === 1, "a player cancellation says they keep it to the period end");
const playerSentence = await txt("ended-player");
ok(playerSentence.includes("Nothing further will be charged"), "  in the card's existing words");
await pick("adminend");
ok(await p.$$eval(D("ended-admin"), es => es.length) === 1, "an admin ending says it ended immediately");
const adminSentence = await txt("ended-admin");
ok(adminSentence.includes("immediately") && adminSentence.includes("not refunded"),
  "  and that the rest of the paid period was not refunded");
ok(playerSentence !== adminSentence && !adminSentence.includes("Nothing further will be charged"),
  "  CONTROL: the two are different sentences, not one sentence shown twice");
ok(adminSentence.includes("Duplicate account"), "  and the reason on file is shown, which Retool never captures");

// ══ 5. WHICH CONTROLS APPEAR IS THE API'S RULE, NOT A GUESS ═══════════════════════════════════
// Both add endpoints throw USER_ALREADY_SUBSCRIBED on status in (ACTIVE, ADDED_FROM_ADMIN);
// unsubscribeForAdmin matches status != CANCELED. So a self-cancelled row is still endable.
await pick("paid");
ok((await acts()).join() === "act-price,act-end", `a live membership offers price and end (${(await acts()).join(", ")})`);
await pick("none");
ok((await acts()).join() === "act-add", "a non-member offers only add");
ok((await txt("add-why")).includes("No membership on file"), "  and says why the others are absent");
await pick("adminend");
ok((await acts()).join() === "act-add", "a closed membership can be reopened, because CANCELED does not block");
await pick("selfcancel");
ok((await acts()).includes("act-end"),
  "a player-cancelled membership is still endable, because its status is still ACTIVE");
await pick("comped");
ok((await acts()).join() === "act-price,act-end", "  CONTROL: and a comp offers both, so the rule is not 'Stripe only'");
ok(await p.$$eval(D("price-why"), es => es.length) === 1, "  with the comp price caveat next to the button");

// ══ 6. DOLLARS ON SCREEN, CENTS ON THE WIRE, BOTH VISIBLE ═════════════════════════════════════
// Retool's field is a bare number times 100 on send. An operator typing 4900 meaning $49 sends
// $4,900 and nothing on screen contradicts them.
await pick("paid");
await p.click(D("act-price")); await p.waitForTimeout(120);
ok(await p.$eval(D("px"), e => e.value) === "49.00", "the price field opens on the current price in dollars");
ok(await p.$eval(D("save"), e => e.disabled) === true, "  and save is dead until the number actually changes");
await p.fill(D("px"), "55"); await p.waitForTimeout(120);
ok(await p.$eval(D("cents"), e => e.textContent.trim()) === "5500",
  `  typing 55 sends 5500 cents (${await p.$eval(D("cents"), e => e.textContent.trim())})`);
ok(await p.$eval(D("save"), e => e.disabled) === false, "  and save wakes up");
ok((await txt("wire")).includes("$49.00"), "  CONTROL: the old price is still shown beside the new one");
ok((await p.$eval(".what", e => e.textContent)).includes("proration off"),
  "the dialog says proration is off, so this month is neither re-charged nor refunded");
await p.fill(D("px"), ""); await p.waitForTimeout(120);
ok(await p.$eval(D("save"), e => e.disabled) === true, "  an empty field cannot be saved as zero");
await p.click(D("cancel")); await p.waitForTimeout(100);
await pick("comped");
await p.click(D("act-price")); await p.waitForTimeout(120);
ok((await p.$eval(".what", e => e.textContent)).includes("No charge exists to change"),
  "  CONTROL: on a comp the same dialog says there is no charge behind it");
await p.click(D("cancel")); await p.waitForTimeout(100);

// ══ 7. ENDING REQUIRES A REASON, AND SAYS WHAT ENDING MEANS ═══════════════════════════════════
await pick("paid");
await p.click(D("act-end")); await p.waitForTimeout(120);
ok(await p.$eval(D("save"), e => e.disabled) === true, "end is refused until a reason is typed");
await p.fill(D("reason"), "   "); await p.waitForTimeout(120);
ok(await p.$eval(D("save"), e => e.disabled) === true, "  and whitespace is not a reason");
await p.fill(D("reason"), "Duplicate account"); await p.waitForTimeout(120);
ok(await p.$eval(D("save"), e => e.disabled) === false, "  CONTROL: a real reason enables it");
const hot = await p.$eval(".what.hot", e => e.textContent);
ok(hot.includes("immediately") && hot.includes("not refunded"),
  "the confirm says immediately, and that the unused period is not refunded");
ok(hot.includes("refund in Stripe separately"), "  and names the manual step, since this route cannot do it");
await p.click(D("cancel")); await p.waitForTimeout(100);
await pick("comped");
await p.click(D("act-end")); await p.waitForTimeout(120);
ok((await p.$eval(".what.hot", e => e.textContent)).includes("no Stripe subscription behind this comp"),
  "  CONTROL: ending a comp says nothing is refunded because nothing was charged");
await p.click(D("cancel")); await p.waitForTimeout(100);

// ══ 8. TWO WAYS TO ADD, NAMED BY WHAT THEY DO ═════════════════════════════════════════════════
// /users/{id} is called "subscribe" in the backend and creates no Stripe subscription at all;
// /users/{id}/free creates a real one. Nobody can guess that from the endpoint names.
await pick("none");
await p.click(D("act-add")); await p.waitForTimeout(120);
ok(await p.$$eval(D("kind"), es => es.length) === 2, "two kinds of membership are offered");
ok(await p.$eval(`${D("kind")}[data-k="comp"]`, e => e.dataset.on) === "1", "  it opens on the comp, which cannot renew or fail");
ok(await p.$eval(D("addpath"), e => e.textContent).then(t => t.endsWith("/43902")),
  `  and the path has no /free suffix (${await p.$eval(D("addpath"), e => e.textContent)})`);
ok((await txt("kind")).includes("$49.00"), "  the comp card names the city plan price it will record");
await p.click(`${D("kind")}[data-k="free"]`); await p.waitForTimeout(120);
ok(await p.$eval(D("addpath"), e => e.textContent).then(t => t.endsWith("/free")),
  "  CONTROL: choosing the other one changes the endpoint, so the two are not cosmetic");
ok((await p.$eval(".what", e => e.textContent)).includes("Neither one charges anybody"),
  "and the dialog says plainly that neither kind bills or counts as a paid member");
await p.click(D("cancel")); await p.waitForTimeout(100);

// ══ 9. GEOMETRY ═══════════════════════════════════════════════════════════════════════════════
for (const vw of [390, 1100]) {
  await p.setViewportSize({ width: vw, height: 1000 });
  await load();
  ok(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    `${vw}px: no page-level horizontal scroll`);
  ok(await p.$$eval(`${D("acts")} button, ${D("sw")}`, es => es.every(e => e.getBoundingClientRect().height >= 32)),
    `  ${vw}px: every control clears 32px`);
  await p.click(D("act-price")); await p.waitForTimeout(120);
  ok(await p.$eval(D("px"), e => e.getBoundingClientRect().height >= 38),
    `  ${vw}px: the price field clears 38px`);
  ok(await p.evaluate(() => { const d = document.querySelector(".dlg").getBoundingClientRect();
    return d.left >= -1 && d.right <= window.innerWidth + 1; }),
    `  ${vw}px: the dialog fits inside the screen`);
  await p.click(D("cancel")); await p.waitForTimeout(100);
}

// ══ 10. LIGHT, NOT DARK ═══════════════════════════════════════════════════════════════════════
await p.setViewportSize({ width: 1100, height: 1000 });
await p.emulateMedia({ colorScheme: "dark" });
await load();
const bg = await p.$eval("body", e => getComputedStyle(e).backgroundColor);
ok(bg === "rgb(244, 246, 244)", `with the OS set to dark the page is still light (${bg})`);

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

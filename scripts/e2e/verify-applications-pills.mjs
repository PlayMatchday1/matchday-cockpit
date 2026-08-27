// APPLICATIONS — THE GREY CHIPS ACTUALLY RENDER.
//   node scripts/e2e/verify-applications-pills.mjs      (needs `npm run dev` up)
//
// THIS ASSERTS THE COMPUTED STYLE, NOT THE CLASS NAME, and that distinction is the whole point: a
// test that checked className="pill lock" PASSES ON EXACTLY THE BUG IT IS MEANT TO CATCH. The
// elements always had the right class. What they did not have was the rule.
//
// THE BUG: styled-jsx scopes a <style jsx> block to the JSX inside the COMPONENT THAT DECLARES IT.
// Locked, CityCell, Phone and D are sibling function components in ApplicationsView.tsx, so their
// elements were emitted with the class name and WITHOUT the jsx-<hash> scope class. `.pill.lock`
// computed to background rgba(0,0,0,0) and font-size 13px — transparent, no padding, no radius.
// The grey chips have never rendered.
//
// It was invisible because nothing looked broken; the page just looked plainer than intended. The
// page's own subtitle says "grey fields come from the form and cannot be edited here. Blue fields
// are yours." — describing a treatment that did not exist, so half its grammar was missing.
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
const BASE = process.env.BASE || "http://localhost:3000";
let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const is = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

const transparent = (c) => !c || c === "transparent" || /rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)/.test(c);
const pxSum = (s) => (s || "").split(" ").reduce((a, v) => a + (parseFloat(v) || 0), 0);

async function main() {
  process.loadEnvFile(".env.local");
  const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
  const link = await svc.auth.admin.generateLink({ type: "magiclink", email: "rmancuso@playmatchday.com" });
  const vv = await anon.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token });
  const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).host.split(".")[0];
  const storageState = { cookies: [], origins: [{ origin: BASE, localStorage: [{ name: `sb-${ref}-auth-token`, value: JSON.stringify(vv.data.session) }] }] };
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1440, height: 950 }, storageState });
  const p = await ctx.newPage();
  await p.goto(`${BASE}/match-ops/applications`, { waitUntil: "domcontentloaded" });
  await p.waitForSelector('[data-testid="apps-row"]', { timeout: 240000 });   // presence before measuring
  await p.waitForSelector(".pill.lock", { timeout: 60000 });

  /* THE POSITIVE CONTROL COMES FIRST, and it is a real one: an element given the SAME class names
   * but placed OUTSIDE the .apps root gets the class and not the rule — which is precisely the
   * shape of the bug. If the assertions below cannot tell that element from a real chip, they are
   * measuring nothing. */
  const control = await p.evaluate(() => {
    const el = document.createElement("span");
    el.className = "pill lock";
    el.textContent = "control";
    document.body.appendChild(el);              // deliberately NOT inside .apps
    const c = getComputedStyle(el);
    const out = { bg: c.backgroundColor, padding: c.padding, radius: c.borderRadius };
    el.remove();
    return out;
  });
  is("control — an unscoped .pill.lock has a TRANSPARENT background", transparent(control.bg), true);
  is("control — …and no padding", pxSum(control.padding), 0);
  console.log(`     (control computed: bg=${control.bg} padding=${control.padding || "0px"})`);

  const grab = (sel) => p.$eval(sel, (el) => {
    const c = getComputedStyle(el);
    return { bg: c.backgroundColor, padding: c.padding, radius: c.borderRadius, color: c.color, display: c.display, fontSize: c.fontSize, cls: el.getAttribute("class") };
  });

  for (const [label, sel] of [
    ["Locked (grey, from the form)", ".pill.lock"],
    ["a status/derived chip", ".pill"],
  ]) {
    const s = await grab(sel);
    console.log(`  ${label}: bg=${s.bg} padding=${s.padding} radius=${s.radius} class="${s.cls}"`);
    is(`${label}: background is NOT transparent`, transparent(s.bg), false);
    is(`${label}: padding is non-zero`, pxSum(s.padding) > 0, true);
    is(`${label}: it is a rounded chip, not bare text`, parseFloat(s.radius) > 0, true);
    is(`${label}: it lays out as a chip`, s.display.includes("flex") || s.display === "inline-block", true);
    /* AND IT IS NOT PASSING BECAUSE OF THE CLASS NAME. The control above proves the same class,
     * unscoped, fails every one of these. */
    is(`${label}: differs from the unscoped control`, s.bg !== control.bg, true);
  }

  // THE GREY/BLUE GRAMMAR THE SUBTITLE PROMISES. Grey = from the form; blue = ours.
  const sub = await p.textContent(".sub");
  is("the subtitle still promises the grey/blue treatment", /grey fields come from the form/i.test(sub), true);
  const grey = await grab(".pill.lock");
  const blue = await p.$eval(".sel", (el) => getComputedStyle(el).borderColor);
  is("…and the grey is a real fill", transparent(grey.bg), false);
  is("…and the blue side has its own border", transparent(blue), false);
  is("…and they are different colours", grey.bg !== blue, true);

  /* EVERY SELECTOR IN A GLOBAL BLOCK MUST STAY ON THIS PAGE. `global` is what reaches a sibling
   * component; the .apps prefix is what stops it reaching the rest of the app. A rule that lost its
   * prefix would style another page silently. */
  const leaked = await p.evaluate(() => {
    const el = document.createElement("div");
    el.className = "row thead tile pill sel inp exp detail search banner tabs";
    document.body.appendChild(el);
    const c = getComputedStyle(el);
    const styled = c.display === "grid" || !(!c.backgroundColor || c.backgroundColor === "rgba(0, 0, 0, 0)");
    el.remove();
    return styled;
  });
  is("no rule from this page styles an element outside .apps", leaked, false);

  await ctx.close(); await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });

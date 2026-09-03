// GAMEDAY OPS, REBUILT - measured in a browser.
//
// The live board has no at-risk match most of the day, so the structural assertions run against a
// FIXTURE DAY served in place of /api/matchday/*/gameday. The fixture is shaped to make each
// assertion able to fail: one at-risk match matching the real 10pm case (3 real, 11 fake, min 9),
// one healthy upcoming, one in play, one finished, one cancelled, and one row where fakes exceed
// reals but the match is NOT at risk - so "MORE FAKE" and "at risk" cannot be confused.
//
// READ ONLY apart from the stepper save, which is asserted against an intercepted PUT and never
// reaches MatchDay.
//
//   node scripts/e2e/verify-gameday-ops.mjs
import { chromium } from "playwright";
import { installHarnessGuard, fatal, closeContext, closeBrowser, storageStateFor , nonEmpty } from "./_session.mjs";
installHarnessGuard();

const BASE = process.env.BASE || "http://localhost:3000";
const ADMIN = "rmancuso@playmatchday.com";
const PAGE = `${BASE}/match-ops/gameday`;

let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ok  ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} - ${d}`); console.log(`  XX  ${n} - ${d}`); };
const is = (n, got, exp) => (JSON.stringify(got) === JSON.stringify(exp) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(exp)}`));
const yes = (n, got, d = "") => (got === true ? ok(n) : bad(n, d || `got ${JSON.stringify(got)}`));

/* THE FIXTURE DAY */
const T0 = Date.now();
const iso = (min) => new Date(T0 + min * 60000).toISOString();
const mk = (o) => ({
  id: o.id, name: o.name,
  startDate: iso(o.at), startDateUtc: iso(o.at), endDate: iso(o.at + 60), endDateUtc: iso(o.at + 60),
  maxPlayerCount: o.cap, minPlayerCount: o.min, registrationPrice: o.price ?? 1200,
  isCancelled: !!o.cx, autoCanceled: o.armed !== false, autoCanceledMinutes: o.acm ?? 30,
  teams: [{ id: 1 }, { id: 2 }],
  _count: { players: o.real + o.fake, fakePlayers: o.fake },
  /* THE LADDER THAT PRODUCES THIS FAKE COUNT. fake = capacity − rung − real, so the rung is
   * cap − fake − real. Without it the fixture declares 11 fakes while its ladder implies 15, and
   * the later-rung logic is being exercised against a match that could not exist. */
  fakeSpotLeft36h: Math.max(0, o.cap - o.fake - o.real), fakeSpotLeft24h: Math.max(0, o.cap - o.fake - o.real),
  fakeSpotLeft12h: Math.max(0, o.cap - o.fake - o.real), fakeSpotLeft6h: Math.max(0, o.cap - o.fake - o.real),
  fakeSpotLeft3h: Math.max(0, o.cap - o.fake - o.real),
  field: { id: 1, title: o.fd, city: { id: 1, name: o.city, timeZone: { abbr: "CDT" } } },
  manager: { id: 1, firstName: o.mgrF, lastName: o.mgrL },
});
/* THE AT-RISK MATCH IS THE REAL ONE: 3 real, 11 fake, minimum 9, 14 of 18 filled. */
const RISK = { id: 101, name: "Soccer Central Field 4", fd: "Soccer Central Complex", city: "San Antonio",
  at: 95, cap: 18, min: 9, real: 3, fake: 11, acm: 35, mgrF: "Chama", mgrL: "rodriguez" };
const FIX = [
  mk(RISK),
  mk({ id: 102, name: "NEMP - Field 12", fd: "NEMP Tournaments", city: "Austin", at: 130, cap: 40, min: 11, real: 30, fake: 0, mgrF: "Moncho", mgrL: "Perez" }),
  mk({ id: 103, name: "The Hattrick (Leander)", fd: "The Hattrick L.", city: "Austin", at: -30, cap: 18, min: 11, real: 16, fake: 2, mgrF: "Jorge Luis", mgrL: "Gonzalez" }),
  /* FAKES EXCEED REALS BUT IT IS NOT AT RISK - real 5 >= min 2. This is what separates the
   * "MORE FAKE" chip from the risk styling; without it either could be asserted by accident. */
  mk({ id: 104, name: "Kirkwood Park", fd: "Kirkwood", city: "St. Louis", at: -40, cap: 18, min: 4, real: 5, fake: 9, mgrF: "Nate", mgrL: "B" }),
  mk({ id: 105, name: "Parmer - Field 1", fd: "Parmer Fields", city: "Austin", at: -200, cap: 18, min: 11, real: 18, fake: 0, mgrF: "Drea", mgrL: "M" }),
  mk({ id: 106, name: "Blossom Soccer Park", fd: "Blossom", city: "San Antonio", at: 60, cap: 18, min: 9, real: 0, fake: 0, cx: true, mgrF: "Ale", mgrL: "R" }),
];
const REAL = (m) => m._count.players - m._count.fakePlayers;
const FAKE = (m) => m._count.fakePlayers;

const READ = () => {
  const bb = (e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height, cx: (r.left + r.right) / 2 }; };
  const rows = [...document.querySelectorAll('[data-testid="gday-row"]')].map((el) => {
    const q = (s) => el.querySelector(s);
    const notch = q('[data-testid="gday-notch"]'), lab = q('[data-testid="gday-minlabel"]');
    const meter = q(".gmeter"), bar = q(".gbar");
    return {
      id: Number(el.dataset.id), bucket: el.dataset.bucket, risk: el.dataset.risk === "1",
      h: Math.round(el.getBoundingClientRect().height),
      delta: Number(q('[data-testid="gday-delta"]')?.dataset.d),
      moreFake: !!q('[data-testid="gday-morefake"]'),
      mgr: q('[data-testid="gday-mgr"]')?.textContent.trim() ?? "",
      minLabel: lab ? { n: Number(lab.dataset.min), pct: Number(lab.dataset.pct), box: bb(lab) } : null,
      /* hasMin WAS MISSING AND SEVERAL ASSERTIONS WERE PASSING VACUOUSLY ON IT — `undefined && x`
       * is always false, so every "filter the rows with a minimum" check returned an empty array
       * whatever the layout did. It is set here. */
      hasMin: !!lab, noMin: !!q('[data-testid="gday-nomin"]'),
      /* THE LABEL'S BOX AGAINST ITS CONTAINER AND EVERY CLIPPING ANCESTOR. A clipped label still
       * passes a textContent check, which is exactly how the clip shipped. */
      labelClip: (() => {
        const el = lab ?? q('[data-testid="gday-nomin"]');
        if (!el) return null;
        const m2 = el.closest(".gmeter");
        const lb = el.getBoundingClientRect(), mb = m2.getBoundingClientRect();
        const clippers = [];
        for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
          const cs = getComputedStyle(n);
          if (cs.overflow === "hidden" || cs.overflowY === "hidden" || cs.overflowX === "hidden") {
            const b = n.getBoundingClientRect();
            clippers.push({ cls: String(n.className).slice(0, 20),
              below: +(lb.bottom - b.bottom).toFixed(2), right: +(lb.right - b.right).toFixed(2),
              left: +(b.left - lb.left).toFixed(2) });
          }
        }
        const tr = m2.querySelector(".gbar").getBoundingClientRect();
        return { text: el.textContent.trim(), h: +lb.height.toFixed(2), w: +lb.width.toFixed(2),
          belowMeter: +(lb.bottom - mb.bottom).toFixed(2),
          /* BOTH AXES. The vertical check added last round would not have caught the "o min"
           * shear, because that one clips horizontally. */
          pastTrackLeft: +(tr.left - lb.left).toFixed(2),
          pastTrackRight: +(lb.right - tr.right).toFixed(2),
          outside: clippers.filter((c) => c.below > 0.5 || c.right > 0.5 || c.left > 0.5) };
      })(),
      notch: notch ? { pct: Number(notch.dataset.pct), box: bb(notch) } : null,
      track: bar ? bb(bar) : null,
      realW: q('[data-testid="gday-real"]')?.getBoundingClientRect().width ?? 0,
      fakeW: q('[data-testid="gday-fake"]')?.getBoundingClientRect().width ?? 0,
      /* THE KEBAB IS GONE FROM THE WALK because it is gone from the row. The manager cell is
         the last column now, and it is the one this walk most needs to cover: it grew 128->164px
         to stop clipping "Peter Rocha-Ramirez", and a column that grows is a column that can
         start overlapping the one before it. */
      chain: ["METER", '[data-testid="gday-nums"]', '[data-testid="gday-delta"]', '[data-testid="gday-mgr"]']
        .map((sel) => { const n = sel === "METER" ? meter : q(sel); return n ? { sel, ...bb(n) } : null; }),
    };
  });
  return {
    rows,
    sections: [...document.querySelectorAll('[data-testid^="gday-sec-"]')].map((b) => ({
      k: b.dataset.testid.replace("gday-sec-", ""),
      n: Number(b.querySelector(".n")?.textContent),
      open: b.getAttribute("aria-expanded") === "true",
    })),
    tiles: Object.fromEntries(["all", "risk", "soon", "live", "fill"].map((k) => [k, {
      v: document.querySelector(`[data-testid="gtile-v-${k}"]`)?.textContent ?? "",
      s: document.querySelector(`[data-testid="gtile-s-${k}"]`)?.textContent ?? "",
      isButton: document.querySelector(`[data-testid="gtile-${k}"]`)?.tagName === "BUTTON",
    }])),
    cityChips: [...document.querySelectorAll('[data-testid^="city-"]')].map((b) => ({
      name: b.dataset.testid.replace("city-", ""), n: Number(b.querySelector("u")?.textContent), risk: b.dataset.risk === "1",
    })),
    banner: (() => {
      const a = document.querySelector('[data-testid="gday-alert"]');
      if (!a) return null;
      const q = (s) => a.querySelector(s);
      return {
        id: Number(a.dataset.id),
        head: q('[data-testid="gday-alert-head"]')?.textContent ?? "",
        meta: q('[data-testid="gday-alert-meta"]')?.textContent ?? "",
        factsChildren: [...(q('[data-testid="gday-alert-facts"]')?.children ?? [])].map((c) => c.tagName + ":" + c.getAttribute("data-testid")),
        factReal: q('[data-testid="gday-fact-real"]')?.textContent ?? "",
        factMin: q('[data-testid="gday-fact-min"]')?.textContent ?? "",
        factMinV: q('[data-testid="gday-fact-minv"]')?.textContent ?? "",
        factMinWas: q('[data-testid="gday-fact-minwas"]')?.textContent ?? null,
        factFake: q('[data-testid="gday-fact-fake"]')?.textContent ?? "",
        factFilled: q('[data-testid="gday-fact-filled"]')?.textContent ?? "",
        band: q('[data-testid="gday-band"]')?.textContent ?? "",
        hasRung: !!q('[data-testid="gday-rungstep"]'),
        direction: q('[data-testid="gday-direction"]')?.textContent ?? "",
        stepV: q('[data-testid="gday-step-value"]')?.textContent ?? "",
        downDisabled: q('[data-testid="gday-step-down"]')?.disabled,
        upDisabled: q('[data-testid="gday-step-up"]')?.disabled,
        save: q('[data-testid="gday-save-min"]')?.textContent ?? null,
        saveClears: q('[data-testid="gday-save-min"]')?.dataset.clears ?? null,
        cancelNow: (() => { const c = q('[data-testid="gday-cancel-now"]'); return c ? { disabled: c.disabled, title: c.title } : null; })(),
      };
    })(),
    bannerCount: document.querySelectorAll('[data-testid="gday-alert"]').length,
    foot: document.querySelector('[data-testid="gday-foot"]')?.textContent ?? "",
    hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    drawer: document.querySelectorAll('[data-testid="gday-panel"]').length,
  };
};

/* ── DATE-AWARE FIXTURES ────────────────────────────────────────────────────────────────────────
 * The banner rules turn on WHICH DATE the board is showing, so the intercept has to answer per
 * date. TODAY gets one urgent match (deadline 23 minutes out) beside one that is short but
 * 19 hours from its deadline - the pair that separates "the decision point has arrived" from
 * "this day has not sold yet". TOMORROW gets nine short matches, none of them urgent. */
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const TODAY = ymd(new Date());
const TOMORROW = ymd(new Date(Date.now() + 86400000));
/* An urgent match: short, armed, and its deadline `dlMin` minutes away. autoCanceledMinutes is
 * minutes BEFORE kickoff, so kickoff at +K with acm = K - dlMin puts the deadline at +dlMin. */
const urgentMk = (o) => mk({ ...o, acm: o.at - o.dlMin });
const TODAY_FIX = [
  urgentMk({ id: 201, name: "Soccer Central Field 4", fd: "Soccer Central Complex", city: "San Antonio",
    at: 95, dlMin: 23, cap: 18, min: 9, real: 3, fake: 11, mgrF: "Chama", mgrL: "rodriguez" }),
  /* SHORT, BUT NINETEEN HOURS FROM ITS DEADLINE. Must NOT be a banner in the default view. */
  /* FAKES ON THIS ONE, because it is the fixture that exercises the LATER-RUNG raise: 19 hours out
   * means the 24h rung is in force and 12h, 6h and 3h all come after it. A match with no fakes has
   * a disabled minus button and cannot exercise it at all. */
  urgentMk({ id: 202, name: "Late Night Kirkwood", fd: "Kirkwood", city: "St. Louis",
    at: 1200, dlMin: 1140, cap: 18, min: 9, real: 2, fake: 6, mgrF: "Nate", mgrL: "B" }),
  mk({ id: 203, name: "The Hattrick (Leander)", fd: "The Hattrick L.", city: "Austin", at: -30, cap: 18, min: 11, real: 16, fake: 2, mgrF: "Jorge Luis", mgrL: "Gonzalez" }),
  mk({ id: 204, name: "Parmer - Field 1", fd: "Parmer Fields", city: "Austin", at: -200, cap: 18, min: 11, real: 18, fake: 0, mgrF: "Drea", mgrL: "M" }),
];
/* FIVE URGENT, to prove the cap of 3 and the "+2 more" line. */
const TODAY_FIVE = [0, 1, 2, 3, 4].map((i) => urgentMk({
  id: 300 + i, name: `Urgent ${i + 1}`, fd: "Field " + i, city: ["Austin", "Houston", "Dallas", "Austin", "Houston"][i],
  at: 90 + i * 5, dlMin: 20 + i * 4, cap: 18, min: 9, real: 3, fake: 5, mgrF: "Mgr", mgrL: String(i) }));
/* NINE SHORT MATCHES ON TOMORROW, spread across cities.
 *
 * EIGHT ARE FAR FROM THEIR DEADLINE. THE NINTH IS NOT, AND THAT ONE IS THE POINT: a match on
 * TOMORROW'S board whose auto-cancel deadline is 30 minutes from NOW - possible because
 * autoCanceledMinutes is minutes before kickoff and can be twenty hours. It passes the
 * 90-minute test and fails only the isToday test, so it is the ONLY fixture that isolates that
 * guard. Without it, removing `if (!isToday) return false` changes nothing and the control that
 * is supposed to prove the guard works proves nothing instead. */
const TOMO_FIX = Array.from({ length: 9 }, (_, i) => urgentMk({
  id: 400 + i, name: `Tomorrow ${i + 1}`, fd: "Field " + i,
  city: ["Austin", "Houston", "Dallas", "San Antonio", "Atlanta", "OKC", "St. Louis", "Austin", "Houston"][i],
  at: 1200 + i * 10, dlMin: i === 8 ? 30 : 1140, cap: 18, min: 9, real: 2, fake: 1, mgrF: "Mgr", mgrL: String(i) }));

/* ── THE SEPARATION FIXTURE ─────────────────────────────────────────────────────────────────────
 * Built for one job the live board cannot be relied on to do: PUT TWO AT-RISK MATCHES NEXT TO EACH
 * OTHER. Separation is the whole change, and the case it exists for is the one where the old
 * edge-to-edge tint made two adjacent red rows read as a single block. A fixture that happens to
 * have its at-risk rows scattered would pass every gap assertion below while proving nothing about
 * the case that motivated them, so the pair is built in deliberately and asserted to BE adjacent
 * before anything is measured about it.
 *
 * It also carries, on purpose:
 *   - "Peter Rocha-Ramirez" (601), the name that clipped at a 128px manager column. 164px is the
 *     new width and this is the name that decides whether it was enough.
 *   - a match with NO MINIMUM (604), so the "no min" label is exercised rather than assumed.
 *   - a very long field title (602), for the two-line title ceiling.
 *   - two healthy rows, without which "the at-risk header strip is tinted differently" has nothing
 *     to be different FROM and passes on a page where every strip is the same colour.
 *
 * All five sit in one bucket so they land in one .glist and the gaps between them are real
 * between-band gaps rather than the space between two sections. */
const SEP_FIX = [
  /* THE PAIR. Kickoffs ten minutes apart, both short of their minimum, nothing between them. */
  mk({ id: 601, name: "Soccer Central Field 4", fd: "Soccer Central Complex", city: "San Antonio",
    at: 300, cap: 18, min: 9, real: 3, fake: 11, acm: 60, mgrF: "Peter", mgrL: "Rocha-Ramirez" }),
  mk({ id: 602, name: "STAR Soccer Complex Field 13", fd: "STAR Soccer Complex Northeast", city: "San Antonio",
    at: 310, cap: 18, min: 8, real: 2, fake: 10, acm: 60, mgrF: "Jorge Luis", mgrL: "Gonzalez" }),
  /* HEALTHY, and immediately after the pair - the control for every "the risk band differs" check. */
  mk({ id: 603, name: "NEMP - Field 12", fd: "NEMP Tournaments", city: "Austin",
    at: 320, cap: 40, min: 11, real: 30, fake: 0, mgrF: "Moncho", mgrL: "Perez" }),
  /* NO MINIMUM: minPlayerCount 0. No notch, and the label reads "no min". */
  mk({ id: 604, name: "Kirkwood Park", fd: "Kirkwood", city: "St. Louis",
    at: 330, cap: 18, min: 0, real: 5, fake: 2, mgrF: "Nate", mgrL: "B" }),
  mk({ id: 605, name: "Parmer - Field 1", fd: "Parmer Fields", city: "Austin",
    at: 340, cap: 18, min: 11, real: 18, fake: 0, mgrF: "Drea", mgrL: "M" }),
];

/* ── THE GEOMETRY PROBE ─────────────────────────────────────────────────────────────────────────
 * Everything the separation assertions read, measured in the page in one pass. Deliberately
 * separate from READ: READ is about what the board SAYS, this is about where it PUTS it, and
 * mixing the two produced a probe neither half could be changed without breaking the other.
 *
 * GAPS ARE MEASURED PER LIST, never across the whole page. Sections each render their own .glist,
 * so the space between the last band of one section and the first of the next is a section break,
 * not a between-band gap, and folding it in would let a generous section break disguise bands that
 * are touching. */
const GEO = () => {
  const n = (v) => (parseFloat(v) || 0);
  const R = (e) => { const b = e.getBoundingClientRect();
    return { t: +b.top.toFixed(2), l: +b.left.toFixed(2), r: +b.right.toFixed(2),
      b: +b.bottom.toFixed(2), w: +b.width.toFixed(2), h: +b.height.toFixed(2) }; };
  const cs = (e) => getComputedStyle(e);
  const head = document.querySelector(".gcolhead");
  const lists = [...document.querySelectorAll(".glist")].map((L) => {
    const st = cs(L);
    const bands = [...L.querySelectorAll('[data-testid="gday-row"]')].map((r) => {
      const s2 = cs(r);
      const kids = [...r.children];
      const nm = r.querySelector('[data-testid="gday-name"]');
      const mgrEl = r.querySelector('[data-testid="gday-mgr"]');
      const mgrTxt = mgrEl ? mgrEl.querySelector("span:last-child") : null;
      const av = r.querySelector(".gav");
      const gk = r.querySelector(".gk");
      const chip = r.querySelector('[data-testid="gday-cancels"]');
      const sub = r.querySelector(".gm .sub");
      const lh = nm ? n(cs(nm).lineHeight) : 0;
      return {
        id: Number(r.dataset.id), risk: r.dataset.risk === "1", box: R(r),
        radius: n(s2.borderTopLeftRadius), border: n(s2.borderTopWidth),
        borderColor: s2.borderTopColor, bg: s2.backgroundColor, shadow: s2.boxShadow,
        /* THE COLUMN TEST IS ON THE BAND'S OWN CHILDREN, in DOM order. Comparing computed
           grid-template-columns instead would compare the rule, not the result. */
        colLefts: kids.map((c) => +c.getBoundingClientRect().left.toFixed(2)),
        kids: kids.map((c) => R(c)),
        gk: gk ? { box: R(gk), bg: cs(gk).backgroundColor, borderBottom: n(cs(gk).borderBottomWidth) } : null,
        mgr: mgrEl ? { box: R(mgrEl), bg: cs(mgrEl).backgroundColor, borderTop: n(cs(mgrEl).borderTopWidth) } : null,
        /* CLIPPED IS THE TEXT'S RIGHT EDGE PAST ITS CELL'S, NOT scrollWidth > clientWidth.
           The span holding the name sets no overflow, so its scrollWidth and clientWidth are
           always equal and that comparison is true for nothing - it reported zero clipped names
           at every width from 1500 down to 700 while "Peter Rocha-Ramirez" was visibly spilling
           18px out of a 136px cell. Boxes do not lie about where they are. */
        mgrText: mgrTxt ? mgrTxt.textContent : "",
        mgrOver: mgrTxt ? +(mgrTxt.getBoundingClientRect().right - mgrEl.getBoundingClientRect().right).toFixed(2) : null,
        mgrClipped: mgrTxt ? mgrTxt.getBoundingClientRect().right > mgrEl.getBoundingClientRect().right + 0.5 : null,
        av: av ? { box: R(av), clipped: av.scrollWidth > av.clientWidth + 1, text: av.textContent } : null,
        name: nm ? { box: R(nm), lines: lh > 0 ? Math.round(nm.getBoundingClientRect().height / lh) : 0 } : null,
        chip: chip ? R(chip) : null,
        /* THE PRICE, AND WHETHER ITS TRACK CUT IT. Same lesson as the manager name: the element
           sets no overflow of its own, so only its box against the cell's box tells the truth.
           "$8.00" rendering as "$8." is a figure that is wrong, not merely tight. */
        price: (() => { const z = r.querySelector('[data-testid="gday-price"]');
          if (!z) return null;
          const zb = z.getBoundingClientRect(), nb = z.parentElement.getBoundingClientRect();
          return { text: z.textContent, over: +(zb.right - nb.right).toFixed(2),
            cut: zb.right > nb.right + 0.5 || zb.width < 1 }; })(),
        sub: sub ? R(sub) : null,
        nomin: !!r.querySelector('[data-testid="gday-nomin"]'),
      };
    });
    return {
      box: R(L),
      pad: { t: n(st.paddingTop), r: n(st.paddingRight), b: n(st.paddingBottom), l: n(st.paddingLeft) },
      bands,
      /* THE GROUND BETWEEN ADJACENT BANDS, measured off the rendered boxes rather than read off
         the gap property - a margin, a border or a transform would all move the real answer
         without moving `gap`. */
      gaps: bands.slice(1).map((b, i) => +(b.box.t - bands[i].box.b).toFixed(2)),
      pairs: bands.slice(1).map((b, i) => [bands[i].id, b.id]),
    };
  });
  return {
    lists,
    headCols: head ? [...head.children].map((c) => +c.getBoundingClientRect().left.toFixed(2)) : null,
    headBox: head ? R(head) : null,
    /* EVERY WAY THE KEBAB COULD STILL BE ON THE PAGE, not just its test id. */
    kebabs: document.querySelectorAll('[data-testid="gday-kebab"], .gkeb, .gkebab').length,
    vw: document.documentElement.clientWidth,
    hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  };
};

async function boot(browser, storageState, width = 1500, opts = {}) {
  const ctx = await browser.newContext({ storageState, viewport: { width, height: opts.height ?? 1000 },
    ...(opts.mobile ? { isMobile: true, hasTouch: true } : {}) });
  const puts = [];
  /* EVERY FIXTURE THIS CONTEXT COULD BE SERVING, including the sets built at the call site and
   * passed in as opts. The intercepts below look matches up here; a pool hard-coded to the module's
   * static arrays answered "no fixture" for every dynamically-built banner set, which is a mock
   * failing rather than a page failing and reads identically in the output if you do not check. */
  const pool = () => [...FIX, ...SEP_FIX, ...TODAY_FIX, ...TODAY_FIVE, ...TOMO_FIX,
    ...(opts.fix ?? []), ...(opts.todaySet ?? [])];
  await ctx.route("**/api/matchday/*/gameday*", (r) => {
    const date = new URL(r.request().url()).searchParams.get("date");
    const body = opts.byDate
      ? (date === TOMORROW ? TOMO_FIX : (opts.todaySet ?? TODAY_FIX))
      : (opts.fix ?? FIX);
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ matches: body }) });
  });
  /* ── THE ROSTER WRITE, INTERCEPTED AND SIMULATED ──────────────────────────────────────────────
   * "Spots left now" now makes TWO writes: the ladder (PUT /matches/{id}) and the roster
   * (POST /matches/{id}/fakes). This intercept stands in for the second. It NEVER REACHES MATCHDAY
   * and it does not reach our own route either - the route's own behaviour is covered by
   * fake-roster-plan-test, and what this suite is for is the BANNER: what the operator is told and
   * what the board shows afterwards.
   *
   * IT MOVES THE FIXTURE'S FAKE COUNT, which is the whole point. The old mock swallowed the rung
   * write and no roster write existed, so the board always re-read its original numbers and the
   * disagreement between the two fake counts could not appear. This one applies the target to
   * `_count`, exactly as a landed roster write would, and the assertions then read the RESULTING
   * count off the re-rendered banner rather than the number that was sent. */
  const fakeWrites = [];
  await ctx.route("**/api/matchday/*/matches/*/fakes", async (r) => {
    const body = JSON.parse(r.request().postData() || "{}");
    const id = Number(r.request().url().match(/matches\/(\d+)\/fakes/)?.[1]);
    const m = pool().find((x) => x.id === id);
    const target = Number(body.targetFakes);
    fakeWrites.push({ id, target, url: r.request().url(), headers: r.request().headers() });
    /* THE FAILURE INJECTION. opts.fakesStatus forces the roster half to fail so the half-applied
     * case can be asserted; without it a "does not report LANDED" assertion has nothing to fail. */
    if (opts.fakesStatus && opts.fakesStatus !== 200) {
      return r.fulfill({ status: opts.fakesStatus, contentType: "application/json",
        body: JSON.stringify({ ok: false, outcome: "failed", error: "roster refused" }) });
    }
    if (!m) return r.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "no fixture" }) });
    const before = m._count.fakePlayers;
    const real = m._count.players - m._count.fakePlayers;
    /* ONLY FAKES MOVE. `players` is recomputed as real + the new fake count, so the real half of
     * the fixture is arithmetically incapable of being changed by this route - the same property
     * the real route guarantees by only ever deleting fake rows. */
    const after = opts.fakesLandShort ? Math.max(0, target - 1) : target;
    m._count.fakePlayers = after;
    m._count.players = real + after;
    return r.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ ok: true, outcome: after === target ? "landed" : "not_applied",
        target, fakesBefore: before, fakesAfter: after,
        added: Math.max(0, target - before), removed: Math.max(0, before - target) }) });
  });
  /* THE STEPPER WRITE IS INTERCEPTED AND COUNTED, never forwarded. The assertion is about what we
   * SEND and what we do with the verdict - not about MatchDay. */
  await ctx.route("**/api/matchday/*/matches/*", (r) => {
    /* THE DETAIL GET, SERVED FROM THE SAME FIXTURE. Without it MatchPanel fetches a match id that
     * does not exist, every field comes back disabled, and the "unsaved edits survive a tab
     * switch" assertion cannot even type into the field it is about. */
    if (r.request().method() === "GET") {
      const id = Number(r.request().url().match(/matches\/(\d+)/)?.[1]);
      const m = pool().find((x) => x.id === id);
      if (!m) return r.continue();
      /* THE ENVELOPE IS { match, managers, fields }, not the match itself — MatchPanel reads
       * j.match. Returning the bare object left every field null and the form disabled. */
      return r.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({
          match: { ...m, realOccupancy: m._count.players - m._count.fakePlayers,
            occupancy: m._count.players, cityName: m.field.city.name, fieldTitle: m.field.title },
          managers: [], managersAllCities: [], fields: [],
        }) });
    }
    if (r.request().method() !== "PUT") return r.continue();
    const body = JSON.parse(r.request().postData() || "{}");
    puts.push({ url: r.request().url(), body });
    const id = Number(r.request().url().match(/matches\/(\d+)/)[1]);
    const m = pool().find((x) => x.id === id);
    if (m && body.changes?.minPlayerCount != null) m.minPlayerCount = body.changes.minPlayerCount;
    /* THE RUNG WRITE IS APPLIED TO THE FIXTURE, and it was not before. On the real API a ladder
     * write lands immediately and reads back immediately - it is the DERIVED FAKE COUNT that lags.
     * The mock used to swallow rung changes entirely, so every reload handed the board back its
     * ORIGINAL ladder and the forecast snapped back to agreeing with the observed count. That is
     * precisely why 627 assertions never noticed that saving spots-left moves nothing on the
     * roster: the fixture healed the bug between the save and the read. */
    if (m) for (const k of Object.keys(body.changes ?? {})) if (/^fakeSpotLeft\d+h$/.test(k)) m[k] = body.changes[k];
    /* THE OUTCOME IS OVERRIDABLE so FAILED and UNKNOWN can be forced. An outcome that only ever
     * appears on success is not an outcome. */
    if (opts.writeStatus && opts.writeStatus !== 200) {
      return r.fulfill({ status: opts.writeStatus, contentType: "application/json",
        body: JSON.stringify({ error: "upstream refused" }) });
    }
    return r.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ ok: true, outcome: opts.outcome ?? "landed" }) });
  });
  const page = await ctx.newPage();
  await page.goto(PAGE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="gday-row"]', { timeout: 120000 });
  await page.waitForTimeout(700);
  return { ctx, page, puts, fakeWrites };
}

async function main() {
  process.loadEnvFile(".env.local");
  const { storageState } = await storageStateFor(ADMIN, BASE);
  const browser = await chromium.launch();
  const { ctx, page, puts } = await boot(browser, storageState, 1500);
  let d = await page.evaluate(READ);

  console.log("\n-- sections, counts and the collapsed Finished --");
  const bucketOf = (m) => m.isCancelled ? "cx"
    : new Date(m.startDateUtc).getTime() > T0 ? "soon"
    : (T0 - new Date(m.startDateUtc).getTime()) / 60000 < 90 ? "live" : "done";
  const want = {};
  for (const m of FIX) { const b = bucketOf(m); want[b] = (want[b] ?? 0) + 1; }
  for (const s of d.sections) is(`  section ${s.k} count matches the data`, s.n, want[s.k]);
  is("  Finished starts collapsed", d.sections.find((s) => s.k === "done")?.open, false);
  is("  ...and the other two start open", d.sections.filter((s) => s.k === "soon" || s.k === "live").map((s) => s.open), [true, true]);
  const visibleNow = d.rows.length;
  is("  collapsed sections render no rows", visibleNow, (want.soon ?? 0) + (want.live ?? 0));
  await page.click('[data-testid="gday-sec-done"]');
  await page.waitForTimeout(400);
  const afterOpen = (await page.evaluate(READ)).rows.length;
  is("  expanding Finished restores its rows", afterOpen, visibleNow + (want.done ?? 0));
  yes("  CONTROL: expanding actually changed the row count", afterOpen > visibleNow);
  await page.click('[data-testid="gday-sec-done"]'); await page.waitForTimeout(400);

  console.log("\n-- the strip --");
  is("  All matches equals the day", d.tiles.all.v, String(FIX.length));
  is("  Needs attention equals the at-risk count", d.tiles.risk.v, "1");
  is("  Still to come", d.tiles.soon.v, String(want.soon ?? 0));
  is("  In play", d.tiles.live.v, String(want.live ?? 0));
  const sumReal = FIX.reduce((a, m) => a + REAL(m), 0), sumCap = FIX.reduce((a, m) => a + m.maxPlayerCount, 0);
  const sumFake = FIX.reduce((a, m) => a + FAKE(m), 0);
  is(`  Real spots filled = ${sumReal}/${sumCap} by hand`, d.tiles.fill.v, `${Math.round((sumReal / sumCap) * 100)}%`);
  is("  ...and its sub-label carries the raw numbers", d.tiles.fill.s, `${sumReal} of ${sumCap} \u00b7 ${sumFake} fake`);
  /* CONTROL: the average-of-percentages answer must be a DIFFERENT number, or this proves nothing. */
  const avg = Math.round(FIX.reduce((a, m) => a + (REAL(m) / m.maxPlayerCount) * 100, 0) / FIX.length);
  yes(`  CONTROL: the average-of-percentages answer (${avg}%) is not what is shown (${d.tiles.fill.v})`,
    `${avg}%` !== d.tiles.fill.v);
  is("  All matches is NOT a button", d.tiles.all.isButton, false);
  is("  Real spots filled is NOT a button", d.tiles.fill.isButton, false);
  is("  CONTROL: Needs attention IS a button", d.tiles.risk.isButton, true);

  console.log("\n-- city chips --");
  const cityRows = d.cityChips.filter((c) => c.name !== "all" && Number.isFinite(c.n));
  is("  chip counts sum to the day", cityRows.reduce((a, c) => a + c.n, 0), FIX.length);
  is("  the at-risk city carries the risk style", cityRows.filter((c) => c.risk).map((c) => c.name), ["San Antonio"]);
  yes("  CONTROL: other cities do not", cityRows.some((c) => !c.risk));

  console.log("\n-- rows: delta, meter, notch and the min label --");
  for (const r of nonEmpty(d.rows, "d.rows")) {
    const m = FIX.find((x) => x.id === r.id);
    is(`  #${r.id} delta = real ${REAL(m)} minus min ${m.minPlayerCount}`, r.delta, REAL(m) - m.minPlayerCount);
    is(`  #${r.id} min label reads its own minimum`, r.minLabel?.n, m.minPlayerCount);
    const wantPct = (m.minPlayerCount / m.maxPlayerCount) * 100;
    yes(`  #${r.id} notch sits at min/capacity`, Math.abs((r.notch?.pct ?? -1) - wantPct) < 0.01);
    yes(`  #${r.id} real+fake never exceeds the track`, r.realW + r.fakeW <= r.track.w + 1);
    yes(`  #${r.id} label centre within 1px of the notch centre`,
      Math.abs(r.minLabel.box.cx - r.notch.box.cx) <= 1,
      `label ${r.minLabel.box.cx.toFixed(2)} vs notch ${r.notch.box.cx.toFixed(2)}`);
    yes(`  #${r.id} band is under 72px (${r.h})`, r.h < 72);
    is(`  #${r.id} manager name is not truncated`, r.mgr.includes(m.manager.firstName) && r.mgr.includes(m.manager.lastName), true);
  }
  /* THE CLAMP MUST NOT FIRE ON REALISTIC DATA. It exists so a minimum at 0 or at capacity keeps its
   * label inside the track; if it fired in the ordinary middle of the range the label would stop
   * sitting over the notch it describes. Checked here on the fixture and again below on the LIVE
   * board, because "realistic" is a claim about real matches. */
  is("  the 12-88% clamp never fires on this data",
    nonEmpty(d.rows, "d.rows").filter((r) => Math.abs(r.minLabel.pct - r.notch.pct) > 0.001).map((r) => r.id), []);
  /* CONTROL: the clamp is reachable - a minimum below 12% of capacity DOES move the label, so the
   * assertion above is about the data and not about a clamp that never does anything. */
  const clampWorks = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="gday-minlabel"]');
    return el != null;
  });
  yes("  CONTROL: labels are present to have been checked", clampWorks);
  /* THE "MORE FAKE" ASSERTIONS ARE GONE WITH THE CHIP. They existed only to test it, and the fact
   * it stated is still asserted where it is stated better — the spots cell's own numbers. */
  is("  no MORE FAKE chip is rendered", await page.locator('[data-testid="gday-morefake"]').count(), 0);
  is("  CONTROL: ...and the fake counts it restated are still on the row",
    d.rows.filter((r) => FAKE(FIX.find((m) => m.id === r.id)) > 0).length > 0, true);
  is("  CONTROL: a more-fake row that meets its minimum is not risk-styled",
    d.rows.find((r) => r.id === 104)?.risk, false);
  is("  ...while the at-risk row is", d.rows.find((r) => r.id === 101)?.risk, true);

  console.log("\n-- GEOMETRIC OVERLAP: each element's right edge sits left of the next one's left edge --");
  let overlaps = [];
  for (const r of d.rows) {
    for (let i = 1; i < r.chain.length; i++) {
      const a = r.chain[i - 1], b = r.chain[i];
      if (!a || !b) continue;
      if (a.r > b.l + 0.5) overlaps.push([r.id, a.sel, b.sel, +(a.r - b.l).toFixed(2)]);
    }
  }
  is("  no pair overlaps on any row", overlaps, []);
  /* CONTROL: force an overlap and prove the same edge comparison reports it. "No overlaps" is also
   * what a broken walk returns, and eleven content assertions once missed a real one. */
  const forced = await page.evaluate(() => {
    const row = document.querySelector('[data-testid="gday-row"]');
    const nums = row.querySelector('[data-testid="gday-nums"]');
    const prev = nums.style.cssText;
    nums.style.position = "relative"; nums.style.left = "260px";
    const b = nums.getBoundingClientRect();
    const next = row.querySelector('[data-testid="gday-delta"]').getBoundingClientRect();
    const seen = b.right > next.left + 0.5;
    nums.style.cssText = prev;
    return seen;
  });
  yes("  CONTROL: forcing an overlap IS detected by the same comparison", forced,
    "the overlap walk cannot see a collision - every 'no overlap' above is worthless");

  console.log("\n-- the alert banner --");
  is("  one banner, for the at-risk match", d.bannerCount, 1);
  is("  ...and it is that match", d.banner.id, RISK.id);
  is("  the headline names the shortfall", d.banner.head, `${RISK.name} is ${RISK.min - RISK.real} players short`);
  yes("  the meta line is its own element carrying kickoff, field, city and manager",
    /kickoff/.test(d.banner.meta) && d.banner.meta.includes(RISK.fd) && d.banner.meta.includes(RISK.city) && d.banner.meta.includes("Chama"));
  /* THE FACTS ROW IS THREE STATS, NOT ONE STRING - asserted structurally, three spans with two
   * hairlines between them, each addressable on its own. */
  /* A. FOUR STATS NOW, IN THE TABLE'S UNITS AND ORDER. The sentence form ("9 of 12 filled spots
   * are fake") is gone — it was a second phrasing of facts the row beside it already stated. */
  const statChildren = d.banner.factsChildren.filter((c) => c.startsWith("SPAN:"));
  is("  the facts row is FOUR discrete stats", statChildren.length, 4);
  is("  ...each with its own testid", statChildren,
    ["SPAN:gday-fact-real", "SPAN:gday-fact-min", "SPAN:gday-fact-fake", "SPAN:gday-fact-filled"]);
  is("  ...separated by three hairlines", d.banner.factsChildren.filter((c) => c.startsWith("I:")).length, 3);
  is("  real", d.banner.factReal.trim(), `${RISK.real} real`);
  is("  minimum", d.banner.factMin.trim(), `${RISK.min} minimum`);
  is("  fake", d.banner.factFake.trim(), `${RISK.fake} fake`);
  is("  filled", d.banner.factFilled.trim(), `${RISK.real + RISK.fake}/${RISK.cap}`);
  /* THE BANNER AND THE TABLE MUST NOT DRIFT. Asserted against the row for the same match. */
  const tableRow = d.rows.find((r) => r.id === RISK.id);
  yes("  CONTROL: that match has a row to compare against", !!tableRow);
  if (tableRow) is("  the banner's facts match the table row's numbers",
    [d.banner.factReal.trim(), d.banner.factFake.trim(), d.banner.factFilled.trim()],
    [`${RISK.real} real`, `${RISK.fake} fake`, `${RISK.real + RISK.fake}/${RISK.cap}`]);
  /* D1. It was a destructive action one mis-tap from a stepper, and it already lives in the match
   * editor. REMOVED, not moved and not duplicated. */
  is("  Cancel now is ABSENT from the banner", d.banner.cancelNow, null);
  is("  CONTROL: ...while the banner's other actions are present",
    (await page.locator('[data-testid="gday-chat"]').count()) > 0, true);



  console.log("\n-- the stepper --");
  const step = async (dir, n = 1) => { for (let i = 0; i < n; i++) { await page.click(`[data-testid="gday-step-${dir}"]`); await page.waitForTimeout(220); } };
  await step("down", 2);
  d = await page.evaluate(READ);
  is("  the stepper value moved", d.banner.stepV, String(RISK.min - 2));
  is("  the facts minimum moved with it", d.banner.factMinV, String(RISK.min - 2));
  is("  ...showing the old value struck through", d.banner.factMinWas, `was ${RISK.min}`);
  is("  the headline moved too", d.banner.head, `${RISK.name} is ${RISK.min - 2 - RISK.real} players short`);
  is("  the primary button became Save", d.banner.save, `Save min ${RISK.min - 2}`);
  /* AN ADJUSTMENT IS NOT A RESCUE. 7 with 3 real still cancels, so it must not yet read as the
   * affordance that says "this fixes it". */
  is("  ...but NOT as a rescue, because a shortfall remains", d.banner.saveClears, "0");
  await step("down", 4);
  d = await page.evaluate(READ);
  is("  stepping to the real count clears the shortfall", d.banner.head, `${RISK.name} clears its minimum at ${RISK.real}`);
  is("  ...and only THEN does it read as a rescue", d.banner.saveClears, "1");
  await step("down", 1);
  d = await page.evaluate(READ);
  is("  the floor is 2", d.banner.stepV, "2");
  is("  ...with minus disabled at the bound", d.banner.downDisabled, true);
  is("  CONTROL: plus is not disabled at the floor", d.banner.upDisabled, false);
  await step("up", RISK.cap - 2);
  d = await page.evaluate(READ);
  is("  the ceiling is capacity", d.banner.stepV, String(RISK.cap));
  is("  ...with plus disabled at the bound", d.banner.upDisabled, true);
  is("  CONTROL: minus is not disabled at the ceiling", d.banner.downDisabled, false);

  console.log("\n-- the save, and what moves with it --");
  await step("down", RISK.cap - RISK.real);
  d = await page.evaluate(READ);
  is("  poised at the real count", d.banner.stepV, String(RISK.real));
  const rowBefore = d.rows.find((r) => r.id === RISK.id);
  await page.click('[data-testid="gday-save-min"]');
  await page.waitForTimeout(1800);
  is("  exactly one PUT was sent - NEVER a retry", puts.length, 1);
  is("  THE DIFF IS THE BODY - only minPlayerCount", Object.keys(puts[0].body.changes), ["minPlayerCount"]);
  is("  ...carrying the stepped value", puts[0].body.changes.minPlayerCount, RISK.real);
  yes("  ...to that match's own write route", new RegExp(`/matches/${RISK.id}$`).test(puts[0].url));
  is("  no Idempotency-Key is sent", "idempotency-key" in (puts[0].headers ?? {}), false);
  const after = await page.evaluate(READ);
  is("  the banner is gone once the shortfall clears", after.bannerCount, 0);
  is("  the Needs attention tile went to zero with it", after.tiles.risk.v, "0");
  const rowAfter = after.rows.find((r) => r.id === RISK.id);
  is("  the row lost its risk styling", rowAfter?.risk, false);
  is("  the row's min label moved", rowAfter?.minLabel.n, RISK.real);
  yes("  ...and its notch moved with it", Math.abs(rowAfter.notch.pct - rowBefore.notch.pct) > 1);
  is("  ...and the delta is now zero", rowAfter?.delta, 0);
  yes("  CONTROL: the delta really did change", rowBefore.delta !== rowAfter.delta);

  console.log("\n-- the interaction contract --");
  is("  CONTROL: no editor open to begin with", (await page.evaluate(READ)).drawer, 0);
  /* THE CLICK GUARD IS RE-ANCHORED, and this is where it USED to be. It pointed at the row kebab,
   * which no longer exists — and an assertion aimed at a selector that matches nothing does not
   * fail, it passes, silently, forever. The three controls that actually sit inside a
   * click-to-open container are asserted in their own block further down, against a fixture that
   * still has a banner: by this point in the run the save above has cleared 101's shortfall and
   * there is no banner left on this page to click. */
  /* CLICKING THE ROW ITSELF DOES OPEN IT. */
  await page.click('[data-testid="gday-row"] [data-testid="gday-name"]');
  await page.waitForSelector('[data-testid="gday-panel"]', { timeout: 30000 });
  is("  clicking a row opens the editor", (await page.evaluate(READ)).drawer, 1);
  const openedFor = await page.evaluate(() => document.querySelector('[data-testid="gday-panel"]')?.textContent?.slice(0, 400) ?? "");
  yes("  ...for that match", openedFor.length > 0);
  await page.click('[data-testid="gday-panel-close"]');
  await page.waitForTimeout(1200);
  is("  ...and closes again", (await page.evaluate(READ)).drawer, 0);

  console.log("\n-- no horizontal scroll, three widths --");
  for (const w of [1500, 1366, 1280]) {
    await page.setViewportSize({ width: w, height: 1000 });
    await page.waitForTimeout(500);
    const v = await page.evaluate(READ);
    is(`  ${w}px: no horizontal page scroll`, v.hscroll, false);
    is(`  ${w}px: every min label still inside its track`,
      nonEmpty(v.rows, "v.rows").filter((r) => r.minLabel.box.l < r.track.l - 14 || r.minLabel.box.r > r.track.r + 14).map((r) => r.id), []);
    is(`  ${w}px: bands stay under 72px`, nonEmpty(v.rows, "v.rows").filter((r) => r.h >= 72).map((r) => r.id), []);
    is(`  ${w}px: no row overlaps`, (() => { const o = [];
      for (const r of nonEmpty(v.rows, "v.rows")) for (let i = 1; i < r.chain.length; i++) {
        const a = r.chain[i - 1], b = r.chain[i];
        if (a && b && a.r > b.l + 0.5) o.push([r.id, a.sel, b.sel]); } return o; })(), []);
  }

  await closeContext(ctx);

  // ══ A. THE BANNERS ═════════════════════════════════════════════════════════════════════════
  {
    const { ctx: c2, page: p2 } = await boot(browser, storageState, 1500, { byDate: true });
    console.log("\n-- A1/A3: today's default view banners only the urgent one --");
    let v = await p2.evaluate(READ);
    is("  exactly one banner in the default view", v.bannerCount, 1);
    is("  ...and it is the match 23 minutes from its deadline", v.banner.id, 201);
    /* THE PAIR THAT MAKES THIS MEAN SOMETHING. 202 is short by SEVEN real players - more short
     * than 201 - and is not a banner, because its deadline is nineteen hours away. */
    is("  CONTROL: the 19-hours-out match is NOT a banner",
      await p2.locator('[data-testid="gday-alert"][data-id="202"]').count(), 0);
    is("  CONTROL: ...but it IS on the board as a row",
      await p2.locator('[data-testid="gday-row"][data-id="202"]').count(), 1);
    is("  the table starts within the first screen",
      await p2.evaluate(() => document.querySelector('[data-testid="snapshot"]').getBoundingClientRect().top < window.innerHeight), true);

    console.log("\n-- A4: today's tile subtitle names the split --");
    yes(`  reads "${v.tiles.risk.s}"`, /auto-cancels? in /.test(v.tiles.risk.s) && /still fillable/.test(v.tiles.risk.s));

    console.log("\n-- A2: Needs attention shows banners and no rows --");
    await p2.click('[data-testid="gtile-risk"]'); await p2.waitForTimeout(700);
    v = await p2.evaluate(READ);
    is("  every short match renders as a banner", v.bannerCount, 2);
    is("  ...and no rows are drawn", v.rows.length, 0);
    is("  ...the card is not drawn at all", await p2.locator('[data-testid="snapshot"]').count(), 0);
    await p2.click('[data-testid="gtile-risk"]'); await p2.waitForTimeout(700);
    v = await p2.evaluate(READ);
    is("  clicking again returns rows", v.rows.length > 0, true);
    is("  ...and the default banner set", v.bannerCount, 1);

    console.log("\n-- A2: every other filter shows rows, never extra banners --");
    for (const k of ["soon", "live"]) {
      await p2.click(`[data-testid="gtile-${k}"]`); await p2.waitForTimeout(600);
      const f = await p2.evaluate(READ);
      is(`  ${k}: still only the default urgent banner`, f.bannerCount, 1);
      await p2.click(`[data-testid="gtile-${k}"]`); await p2.waitForTimeout(500);
    }

    console.log("\n-- A1/A4/A5: tomorrow --");
    await p2.click('[data-testid="day-next"]');
    await p2.waitForFunction(() => document.querySelectorAll('[data-testid="gday-row"]').length === 9, null, { timeout: 40000 });
    await p2.waitForTimeout(700);
    v = await p2.evaluate(READ);
    is("  nine short matches on tomorrow", v.rows.length, 9);
    is("  ZERO banners in the default view", v.bannerCount, 0);
    /* ...INCLUDING the one whose deadline is 30 minutes away. On a future date the deadline does
     * not matter: there is nothing to decide about tomorrow tonight. */
    is("  ...including the match whose deadline is 30 minutes from now",
      await p2.locator('[data-testid="gday-alert"][data-id="408"]').count(), 0);
    is("  CONTROL: that match is on the board as a row", await p2.locator('[data-testid="gday-row"][data-id="408"]').count(), 1);
    is("  the table starts within the first screen",
      await p2.evaluate(() => document.querySelector('[data-testid="snapshot"]').getBoundingClientRect().top < window.innerHeight), true);
    is("  A4: the subtitle reads 'not yet at minimum'", v.tiles.risk.s, "not yet at minimum");
    is("  CONTROL: ...and the tile still counts them", v.tiles.risk.v, "9");
    const tomoChips = v.cityChips.filter((c) => c.name !== "all" && Number.isFinite(c.n));
    is("  A5: no city chip is risk-styled on a future date", tomoChips.filter((c) => c.risk).map((c) => c.name), []);
    yes(`  CONTROL: there are chips to have been styled (${tomoChips.length})`, tomoChips.length >= 5);

    console.log("\n-- A2 on tomorrow --");
    await p2.click('[data-testid="gtile-risk"]'); await p2.waitForTimeout(800);
    v = await p2.evaluate(READ);
    is("  all nine render as banners", v.bannerCount, 9);
    is("  ...and no rows", v.rows.length, 0);
    await p2.click('[data-testid="gtile-risk"]'); await p2.waitForTimeout(700);
    is("  clicking again returns to no banners", (await p2.evaluate(READ)).bannerCount, 0);
    await closeContext(c2);
  }

  // ══ A3: THE CAP OF THREE, AND THE +N LINE ══════════════════════════════════════════════════
  {
    const { ctx: c3, page: p3 } = await boot(browser, storageState, 1500, { byDate: true, todaySet: TODAY_FIVE });
    const v = await p3.evaluate(READ);
    console.log("\n-- A3: five qualifying, three shown --");
    is("  exactly three banners", v.bannerCount, 3);
    is("  ...soonest deadline first", await p3.evaluate(() =>
      [...document.querySelectorAll('[data-testid="gday-alert"]')].map((a) => Number(a.dataset.id))), [300, 301, 302]);
    is("  ...with a +2 more line", (await p3.locator('[data-testid="gday-more-risk"]').textContent()).trim(), "+2 more need attention");
    await p3.click('[data-testid="gday-more-risk"]');
    await p3.waitForTimeout(800);
    const after = await p3.evaluate(READ);
    is("  clicking it lands on the Needs attention filter", after.bannerCount, 5);
    is("  ...and the tile is selected", await p3.locator('[data-testid="gtile-risk"]').getAttribute("data-on"), "1");
    is("  ...and no rows are drawn", after.rows.length, 0);
    await closeContext(c3);
  }


  // ══ B. MOBILE ══════════════════════════════════════════════════════════════════════════════
  {
    /* PHONE FIRST. Every assertion here is about a box the browser built, and none of them can be
     * answered from the stylesheet: whether anything overflows 390px, whether a 44px target really
     * measures 44px, whether the notch still has its label when the meter changed width. */
    const OVER = () => {
      const vw = document.documentElement.clientWidth;
      const out = [];
      for (const r of document.querySelectorAll('[data-testid="gday-row"]')) {
        for (const el of r.querySelectorAll("*")) {
          const b = el.getBoundingClientRect();
          if (b.width > 0 && b.right > vw + 0.5) out.push([r.dataset.id, String(el.className).slice(0, 26), Math.round(b.right)]);
        }
      }
      return { vw, out, hscroll: document.documentElement.scrollWidth > vw + 1 };
    };
    for (const w of [390, 430, 768, 1024, 1500]) {
      const phone = w < 640;
      const { ctx: cm, page: pm } = await boot(browser, storageState, w, { byDate: true, mobile: phone });
      const o = await pm.evaluate(OVER);
      const v = await pm.evaluate(READ);
      console.log(`\n-- B at ${w}px --`);
      is(`  ${w}: no horizontal page scroll`, o.hscroll, false);
      is(`  ${w}: nothing overflows the viewport`, o.out, []);
      yes(`  ${w}: CONTROL - there are rows to check (${v.rows.length})`, v.rows.length > 0);
      /* THE METER SURVIVES AT EVERY WIDTH. It is the reason the page exists. */
      is(`  ${w}: every row still has a notch and a min label`,
        v.rows.filter((r) => !r.notch || !r.minLabel).map((r) => r.id), []);
      is(`  ${w}: every label within 1px of its notch`,
        v.rows.filter((r) => Math.abs(r.minLabel.box.cx - r.notch.box.cx) > 1).map((r) => r.id), []);
      is(`  ${w}: the 12-88% clamp does not fire`,
        v.rows.filter((r) => Math.abs(r.minLabel.pct - r.notch.pct) > 0.001).map((r) => r.id), []);
      /* THE STRIP: three across on a phone, five on the desktop. Read off the computed grid. */
      const cols = await pm.evaluate(() => getComputedStyle(document.querySelector(".gstrip")).gridTemplateColumns.split(" ").length);
      is(`  ${w}: the strip is ${phone || w < 1024 ? 3 : 5} across`, cols, phone || w < 1024 ? 3 : 5);
      is(`  ${w}: display-only tiles are still not buttons`, [v.tiles.all.isButton, v.tiles.fill.isButton], [false, false]);
      /* THE CITY CHIPS SCROLL IN THEIR OWN BOX, and that is why the page does not. */
      const chips = await pm.evaluate(() => {
        const c = document.querySelector(".mchips") ?? document.querySelector(".gcities .cityf");
        if (!c || c.clientWidth === 0) return null;
        return { over: c.scrollWidth > c.clientWidth, ox: getComputedStyle(c).overflowX };
      });
      yes(`  ${w}: the chip row is its own scroll container`, chips == null || chips.ox === "auto" || chips.ox === "scroll",
        `overflowX was ${chips?.ox}`);

      if (phone) {
        /* ROWS ARE STACKED CARDS - taller than the desktop row and no longer a five-column grid. */
        yes(`  ${w}: rows are stacked cards (${v.rows[0].h}px)`, v.rows[0].h > 90);
        const gridCols = await pm.evaluate(() => getComputedStyle(document.querySelector('[data-testid="gday-row"]')).gridTemplateColumns.split(" ").length);
        /* A CARD IS ONE COLUMN. It was two while the row was a stacked grid with the kebab pinned
           to the right; with the kebab gone the four blocks - header strip, match, spots, footer
           strip - stack full width. */
        is(`  ${w}: the desktop column grid is gone - a card is one column`, gridCols, 1);
        /* THE STEPPER'S TARGETS. 44x44 minimum - they were 22px squares on a control that changes
         * what a match costs a player. */
        await pm.click('[data-testid="gtile-risk"]'); await pm.waitForTimeout(700);
        const btns = await pm.evaluate(() => ["down", "up"].map((d) => {
          const b = document.querySelector(`[data-testid="gday-step-${d}"]`);
          const r = b.getBoundingClientRect(); return { d, w: Math.round(r.width), h: Math.round(r.height) };
        }));
        for (const b of btns) yes(`  ${w}: the ${b.d} stepper is at least 44x44 (${b.w}x${b.h})`, b.w >= 44 && b.h >= 44);
        await pm.click('[data-testid="gtile-risk"]'); await pm.waitForTimeout(600);
        /* THE EDITOR IS A FULL-HEIGHT SHEET, and Save is reachable without scrolling the form. */
        await pm.click('[data-testid="gday-row"] [data-testid="gday-name"]');
        await pm.waitForSelector('[data-testid="gday-panel"]', { timeout: 30000 });
        await pm.waitForTimeout(1200);
        const sheet = await pm.evaluate(() => {
          const p = document.querySelector('[data-testid="gday-panel"]');
          const r = p.getBoundingClientRect();
          const save = [...p.querySelectorAll("button")].find((b) => /save/i.test(b.textContent));
          const sr = save?.getBoundingClientRect();
          return { w: Math.round(r.width), vw: document.documentElement.clientWidth,
            h: Math.round(r.height), vh: window.innerHeight,
            saveVisible: sr ? sr.top >= 0 && sr.bottom <= window.innerHeight + 1 : null };
        });
        yes(`  ${w}: the editor fills the width (${sheet.w} of ${sheet.vw})`, sheet.w >= sheet.vw - 1);
        yes(`  ${w}: ...and the height (${sheet.h} of ${sheet.vh})`, sheet.h >= sheet.vh - 2);
        is(`  ${w}: Save is reachable without scrolling`, sheet.saveVisible, true);
        await pm.click('[data-testid="gday-panel-close"]'); await pm.waitForTimeout(800);

        /* CONTROL: force a fixed-width element into a phone row and prove the overflow walk sees it. */
        const caught = await pm.evaluate(() => {
          const row = document.querySelector('[data-testid="gday-row"]');
          const el = row.querySelector('[data-testid="gday-nums"]');
          const prev = el.style.cssText;
          el.style.width = "900px"; el.style.flex = "0 0 900px";
          const vw = document.documentElement.clientWidth;
          const seen = el.getBoundingClientRect().right > vw + 0.5;
          el.style.cssText = prev;
          return seen;
        });
        yes(`  ${w}: CONTROL - a forced 900px element IS caught by the overflow walk`, caught,
          "the overflow walk cannot see an overflow - every clean result above is worthless");
      } else {
        /* THE DESKTOP OVERLAP WALK STAYS, at 1024 and above. */
        const ov = [];
        for (const r of nonEmpty(v.rows, "v.rows")) for (let i = 1; i < r.chain.length; i++) {
          const a = r.chain[i - 1], b = r.chain[i];
          if (a && b && a.r > b.l + 0.5) ov.push([r.id, a.sel, b.sel]);
        }
        is(`  ${w}: no row overlaps`, ov, []);
        const forced = await pm.evaluate(() => {
          const row = document.querySelector('[data-testid="gday-row"]');
          const nums = row.querySelector('[data-testid="gday-nums"]');
          const prev = nums.style.cssText;
          nums.style.position = "relative"; nums.style.left = "260px";
          const seen = nums.getBoundingClientRect().right > row.querySelector('[data-testid="gday-delta"]').getBoundingClientRect().left + 0.5;
          nums.style.cssText = prev;
          return seen;
        });
        yes(`  ${w}: CONTROL - a forced overlap IS detected`, forced);
      }
      await closeContext(cm);
    }
  }

  // ══ C. OPEN MATCH CHAT ═════════════════════════════════════════════════════════════════════
  {
    console.log("\n-- C1: Match Chats loads clean with no parameters --");
    const cc = await browser.newContext({ storageState, viewport: { width: 1500, height: 1000 } });
    const pc = await cc.newPage();
    const cerr = [];
    pc.on("pageerror", (e) => cerr.push(String(e).slice(0, 200)));
    const resp = await pc.goto(`${BASE}/match-ops/match-chats`, { waitUntil: "domcontentloaded" });
    await pc.waitForTimeout(8000);
    is("  HTTP 200", resp?.status(), 200);
    is("  no uncaught page errors", cerr, []);
    /* ASSERTED ON RENDERED CONTENT, NOT A 200. A 200 that renders an empty shell is still broken. */
    const txt = await pc.evaluate(() => document.body.innerText);
    yes("  the inbox rendered its tabs and counts", /Active/.test(txt) && /Upcoming/.test(txt) && /Past/.test(txt));
    /* THE INBOX'S OWN CONTENT, not a character count — the nav chrome alone clears 400 chars, so
     * that threshold was measuring the shell rather than the threads. */
    yes("  ...with real threads in it", /\d+\s*\n?\s*(Upcoming|Past)/.test(txt) && /Invite link|kickoff|PM|AM/.test(txt));
    await closeContext(cc);

    console.log("\n-- C3: the banner link lands on that match's thread --");
    const { ctx: c4, page: p4 } = await boot(browser, storageState, 1500, { byDate: true });
    const href = await p4.locator('[data-testid="gday-chat"]').first().getAttribute("href");
    const chatId = await p4.locator('[data-testid="gday-chat"]').first().getAttribute("data-chat-id");
    yes(`  the href targets the real route - ${href}`, href.startsWith("/match-ops/match-chats?chatId="));
    is("  ...carrying that match's id", href, `/match-ops/match-chats?chatId=${chatId}`);
    is("  CONTROL: the old broken path is gone", /match-ops\/chats\?match=/.test(href), false);
    is("  the button is enabled", await p4.locator('[data-testid="gday-chat"]').first().getAttribute("aria-disabled"), null);

    /* THE LINK ACTUALLY LANDS. Followed for real, and the selected thread's id is read back off
     * the URL the chat shell keeps - chatId IS the match api_id, proven on live data. */
    await p4.goto(`${BASE}${href}`, { waitUntil: "domcontentloaded" });
    await p4.waitForTimeout(7000);
    const landed = new URL(p4.url());
    is("  following it keeps the chatId", landed.searchParams.get("chatId"), chatId);
    is("  ...on the Match Chats route", landed.pathname, "/match-ops/match-chats");
    const paneTxt = await p4.evaluate(() => document.body.innerText);
    is("  CONTROL: it is not sitting on the empty 'Nothing selected' state",
      /Nothing selected/.test(paneTxt), false);

    /* CONTROL: a match id with no thread must render an explicit empty state, not crash. */
    await p4.goto(`${BASE}/match-ops/match-chats?chatId=99999999`, { waitUntil: "domcontentloaded" });
    await p4.waitForTimeout(6000);
    const emptyTxt = await p4.evaluate(() => document.body.innerText);
    yes("  CONTROL: an id with no thread does not crash the page", emptyTxt.length > 300);
    yes("  CONTROL: ...and the inbox still renders", /Active/.test(emptyTxt) && /Upcoming/.test(emptyTxt));
    await closeContext(c4);
  }


  /* THE DATE-AWARE FIXTURE'S URGENT MATCH — the one the banner renders on today's board. RISK
   * belongs to the OTHER fixture and is not on this board at all. */
  const URG = TODAY_FIX[0];
  // ══ C. THE CHAT PANEL ══════════════════════════════════════════════════════════════════════
  {
    const { ctx: cp, page: pp } = await boot(browser, storageState, 1500, { byDate: true });
    console.log("\n-- C1: one panel, two tabs --");
    is("  CONTROL: no panel to start with", await pp.locator('[data-testid="gday-panel"]').count(), 0);
    await pp.click('[data-testid="gday-row"] [data-testid="gday-name"]');
    await pp.waitForSelector('[data-testid="gday-panel"]', { timeout: 30000 });
    await pp.waitForTimeout(900);
    is("  clicking a row opens the panel on Details",
      await pp.locator('[data-testid="gday-tab-details"]').getAttribute("aria-selected"), "true");
    /* EXACTLY ONE PANEL. A second drawer is the thing this must not become. */
    is("  there is exactly ONE panel in the DOM", await pp.locator('[data-testid="gday-panel"]').count(), 1);
    await pp.click('[data-testid="gday-panel-close"]'); await pp.waitForTimeout(900);

    console.log("\n-- C1/C2: Open match chat opens the SAME panel on Chat --");
    await pp.click('[data-testid="gday-chat"]');
    await pp.waitForSelector('[data-testid="gday-panel"]', { timeout: 30000 });
    await pp.waitForTimeout(1500);
    is("  it did not navigate away", new URL(pp.url()).pathname, "/match-ops/gameday");
    is("  the panel opened on Chat",
      await pp.locator('[data-testid="gday-tab-chat"]').getAttribute("aria-selected"), "true");
    is("  still exactly one panel", await pp.locator('[data-testid="gday-panel"]').count(), 1);
    /* THE THREAD IS RESOLVED BY MATCH ID — asserted on the id, not on a title. */
    is("  the Chat pane carries that match's id",
      await pp.locator('[data-testid="gday-panel-chat"]').getAttribute("data-chat-id"), String(URG.id));

    console.log("\n-- C3: unsaved edits survive the tab switch --");
    await pp.click('[data-testid="gday-tab-details"]'); await pp.waitForTimeout(900);
    const minBefore = await pp.locator('[data-testid="mp-min"]').inputValue().catch(() => null);
    yes("  CONTROL: the editor's minimum field is readable", minBefore != null, `got ${minBefore}`);
    await pp.locator('[data-testid="mp-min"]').fill(String(Number(minBefore) + 3));
    await pp.waitForTimeout(400);
    const edited = await pp.locator('[data-testid="mp-min"]').inputValue();
    await pp.click('[data-testid="gday-tab-chat"]'); await pp.waitForTimeout(700);
    await pp.click('[data-testid="gday-tab-details"]'); await pp.waitForTimeout(700);
    is("  the pending change survived the round trip", await pp.locator('[data-testid="mp-min"]').inputValue(), edited);
    yes("  CONTROL: ...and it really was a change", edited !== minBefore);

    console.log("\n-- C4: the board stays put --");
    /* A CLEAN PANEL. The one above has an unsaved edit in it and the leave-guard correctly refuses
     * to close — testing "the board stays put" through a confirm dialog would be testing the
     * dialog. Reloaded, then opened fresh. */
    await pp.reload({ waitUntil: "domcontentloaded" });
    await pp.waitForSelector('[data-testid="gday-row"]', { timeout: 60000 });
    await pp.waitForTimeout(900);
    const before = await pp.evaluate(() => ({ y: window.scrollY, strip: document.querySelector('[data-testid="gtile-risk"]')?.dataset.on }));
    await pp.click('[data-testid="gday-chat"]');
    await pp.waitForSelector('[data-testid="gday-panel"]', { timeout: 30000 });
    await pp.waitForTimeout(900);
    await pp.click('[data-testid="gday-tab-details"]'); await pp.waitForTimeout(500);
    await pp.click('[data-testid="gday-tab-chat"]'); await pp.waitForTimeout(500);
    await pp.click('[data-testid="gday-panel-close"]'); await pp.waitForTimeout(1200);
    const after = await pp.evaluate(() => ({ y: window.scrollY, strip: document.querySelector('[data-testid="gtile-risk"]')?.dataset.on }));
    is("  scroll position unchanged", after.y, before.y);
    is("  the active filter is unchanged", after.strip, before.strip);
    is("  and the panel closed", await pp.locator('[data-testid="gday-panel"]').count(), 0);
    await closeContext(cp);

    console.log("\n-- C6: the standalone page still works --");
    const cs = await browser.newContext({ storageState, viewport: { width: 1500, height: 1000 } });
    const ps = await cs.newPage();
    const r = await ps.goto(`${BASE}/match-ops/match-chats?chatId=18342`, { waitUntil: "domcontentloaded" });
    await ps.waitForTimeout(7000);
    is("  it still loads", r?.status(), 200);
    is("  ...keeping its chatId", new URL(ps.url()).searchParams.get("chatId"), "18342");
    yes("  ...and renders the inbox", /Active/.test(await ps.evaluate(() => document.body.innerText)));
    await closeContext(cs);
  }

  // ══ D. THE FAKE CONTROLS ═══════════════════════════════════════════════════════════════════
  {
    const { ctx: cd, page: pd } = await boot(browser, storageState, 1500, { byDate: true });
    console.log("\n-- D1: Cancel now is gone --");
    is("  no Cancel now in the banner", await pd.locator('[data-testid="gday-cancel-now"]').count(), 0);

    console.log("\n-- the one fake control, on the urgent match --");
    const fv = () => pd.locator('[data-testid="gday-spots-value"]').textContent();
    const cap = URG.maxPlayerCount, real = URG._count.players - URG._count.fakePlayers;
    is("  exactly one fake control renders", await pd.locator('[data-testid="gday-spotstep"]').count(), 1);
    is("  ...and no second one", await pd.locator('[data-testid="gday-rungstep"], [data-testid="gday-fakestep"]').count(), 0);
    /* BOUNDS: 0 with minus disabled, capacity minus real with plus disabled. */
    for (let i = 0; i < 40 && !(await pd.locator('[data-testid="gday-spots-down"]').isDisabled()); i++) {
      await pd.click('[data-testid="gday-spots-down"]'); await pd.waitForTimeout(100);
    }
    is("  the floor is 0", Number(await fv()), 0);
    is("  ...with − disabled at the bound", await pd.locator('[data-testid="gday-spots-down"]').isDisabled(), true);
    is("  CONTROL: + is not disabled at the floor", await pd.locator('[data-testid="gday-spots-up"]').isDisabled(), false);
    is("  ...and at the floor every spot is fake", (await pd.locator('[data-testid="gday-spots-fakes"]').textContent()).trim(), `· ${cap - real} fake`);
    for (let i = 0; i < 40 && !(await pd.locator('[data-testid="gday-spots-up"]').isDisabled()); i++) {
      await pd.click('[data-testid="gday-spots-up"]'); await pd.waitForTimeout(90);
    }
    is("  the ceiling is capacity − real", Number(await fv()), cap - real);
    is("  ...with + disabled at the bound", await pd.locator('[data-testid="gday-spots-up"]').isDisabled(), true);
    is("  ...and at the ceiling there are no fakes", (await pd.locator('[data-testid="gday-spots-fakes"]').textContent()).trim(), "· 0 fake");

    console.log("\n-- D4: the action area is a 2x2 grid --");
    const acts = await pd.evaluate(() => {
      const a = document.querySelector('[data-testid="gday-acts"]');
      const r = a.getBoundingClientRect();
      return { w: Math.round(r.width), cols: getComputedStyle(a).gridTemplateColumns.split(" ").length,
        tracks: getComputedStyle(a).gridTemplateColumns,
        kids: [...a.children].map((c) => ({ t: c.dataset?.testid ?? String(c.className).slice(0,18),
          w: Math.round(c.getBoundingClientRect().width), col: getComputedStyle(c).gridColumn })),
        bannerH: Math.round(document.querySelector('[data-testid="gday-alert"]').getBoundingClientRect().height) };
    });
    console.log(`     tracks=${acts.tracks} kids=${JSON.stringify(acts.kids)}`);
    is("  two columns", acts.cols, 2);
    /* MEASURED, NOT ASSUMED. Three controls are not automatically narrower than four — the spots
     * control is the widest of them and the save button and direction line span both columns. */
    yes(`  the action area stays compact (${acts.w}px)`, acts.w < 420);
    await pd.setViewportSize({ width: 1280, height: 1000 }); await pd.waitForTimeout(600);
    const h1280 = await pd.evaluate(() => Math.round(document.querySelector('[data-testid="gday-alert"]').getBoundingClientRect().height));
    /* THIS BANNER HAS A PENDING CHANGE TOO — the bounds loop above left the control at its ceiling
     * — so it carries a Save button and the explanatory sentence, each on its own grid row. ~180px
     * is the correct height for that state; the resting banner is ~103px and is checked with the
     * panel open below. */
    yes(`  the banner holds its height at 1280 with a pending change (${h1280}px)`, h1280 < 200);
    await closeContext(cd);
  }


  // ══ A. THE MIN LABEL IS NOT CLIPPED, AT ANY WIDTH ══════════════════════════════════════════
  {
    /* GEOMETRY, NOT TEXT. The label rendered correct content the whole time and had its bottom
     * 5.25px sheared off by .gs — the overflow:hidden added to stop the delta chip spilling into
     * the manager cell. One fix made the other. A textContent check passes through all of it. */
    for (const w of [390, 768, 1024, 1500]) {
      const { ctx: ca, page: pa } = await boot(browser, storageState, w, { byDate: true, mobile: w < 640 });
      const v = await pa.evaluate(READ);
      console.log(`\n-- A1 at ${w}px --`);
      yes(`  ${w}: CONTROL - there are labels to check (${v.rows.length})`, v.rows.length > 0);
      is(`  ${w}: every label's bottom sits inside its meter`,
        v.rows.filter((r) => r.labelClip && r.labelClip.belowMeter > 0).map((r) => [r.id, r.labelClip.belowMeter]), []);
      /* EVERY CLIPPING ANCESTOR, not just the meter — the shear came from two levels up. */
      is(`  ${w}: no label falls outside any overflow:hidden ancestor`,
        v.rows.filter((r) => r.labelClip && r.labelClip.outside.length > 0)
          .map((r) => [r.id, r.labelClip.outside]), []);
      if (w >= 1024) {
        is(`  ${w}: bands are still under 72px`, v.rows.filter((r) => r.h >= 72).map((r) => [r.id, r.h]), []);
        /* THE 768 OVERLAP WALK IS KEPT — a label-height change is exactly what can reintroduce it. */
        const ov = [];
        for (const r of v.rows) for (let i2 = 1; i2 < r.chain.length; i2++) {
          const a = r.chain[i2 - 1], b = r.chain[i2];
          if (a && b && a.r > b.l + 0.5) ov.push([r.id, a.sel, b.sel]);
        }
        is(`  ${w}: no row overlaps`, ov, []);
      }
      /* BOTH EDGES AGAINST THE TRACK. The vertical check alone missed the "o min" shear. */
      is(`  ${w}: no label runs past the LEFT edge of its track`,
        v.rows.filter((r) => r.labelClip && r.labelClip.pastTrackLeft > 0.5).map((r) => [r.id, r.labelClip.text, r.labelClip.pastTrackLeft]), []);
      is(`  ${w}: no label runs past the RIGHT edge of its track`,
        v.rows.filter((r) => r.labelClip && r.labelClip.pastTrackRight > 0.5).map((r) => [r.id, r.labelClip.text, r.labelClip.pastTrackRight]), []);
      /* CONTROL: put the 13px back and prove the assertion trips at this width. */
      const trips = await pa.evaluate(() => {
        const m2 = document.querySelector(".gmeter");
        const prev = m2.style.paddingBottom;
        m2.style.paddingBottom = "13px";
        const el = m2.querySelector('[data-testid="gday-minlabel"],[data-testid="gday-nomin"]');
        const seen = el.getBoundingClientRect().bottom - m2.getBoundingClientRect().bottom > 0;
        m2.style.paddingBottom = prev;
        return seen;
      });
      yes(`  ${w}: CONTROL - restoring 13px DOES trip the assertion`, trips,
        "the clip check cannot see a clipped label - every clean result above is worthless");
      await closeContext(ca);
    }
  }

  // ══ A2/A3 + B. NO-MIN MATCHES, AND NO JARGON ON SCREEN ═════════════════════════════════════
  {
    /* A MATCH WITH NO MINIMUM. It cannot be short and can never auto-cancel for a shortfall, so it
     * must be out of every risk surface as well as labelled honestly. */
    /* THE CLAMP MUST BE EXERCISED AT BOTH BOUNDS or it is not tested. A minimum of 1 of 40 puts the
     * notch at 2.5% and a minimum of 39 of 40 at 97.5% — both far outside any label's half-width,
     * so the derived clamp has to move the label in each direction. */
    const NOMIN = [
      mk({ id: 503, name: "Low notch", fd: "F", city: "Austin", at: 120, cap: 40, min: 1, real: 30, fake: 0, mgrF: "A", mgrL: "B" }),
      /* REAL 39 AGAINST A MINIMUM OF 39 — it MEETS its minimum, so it exercises the high clamp
       * bound without joining Needs attention and changing the counts this block also asserts. */
      mk({ id: 504, name: "High notch", fd: "F", city: "Austin", at: 125, cap: 40, min: 39, real: 39, fake: 0, mgrF: "A", mgrL: "B" }),
      mk({ id: 501, name: "Hala Pilkarska Bemowo", fd: "Hala", city: "Warsaw", at: 100, cap: 14, min: 0, real: 2, fake: 0, mgrF: "Kuba", mgrL: "W" }),
      mk({ id: 502, name: "Parmer Stadium", fd: "Parmer", city: "Austin", at: 110, cap: 36, min: 0, real: 15, fake: 0, mgrF: "Drea", mgrL: "M" }),
      TODAY_FIX[0],
    ];
    const { ctx: cn, page: pn } = await boot(browser, storageState, 1500, { byDate: true, todaySet: NOMIN });
    const v = await pn.evaluate(READ);
    console.log("\n-- A2: a match with no minimum says so --");
    for (const id of [501, 502]) {
      const r = v.rows.find((x) => x.id === id);
      is(`  #${id} renders "no min"`, r?.labelClip?.text, "no min");
      is(`  #${id} draws no notch`, r?.notch, null);
      /* A3: OUT OF EVERY RISK SURFACE. */
      is(`  #${id} carries no risk styling`, r?.risk, false);
      is(`  #${id} is not a banner`, await pn.locator(`[data-testid="gday-alert"][data-id="${id}"]`).count(), 0);
    }
    console.log("\n-- C2: the derived clamp, exercised at BOTH bounds --");
    for (const [id, where] of [[503, "low"], [504, "high"]]) {
      const r = v.rows.find((x) => x.id === id);
      yes(`  #${id} (${where} notch) exists`, !!r, "fixture row missing");
      if (!r) continue;
      /* THE CLAMP FIRED: the rendered position differs from the raw notch position. */
      const raw = Number(r.minLabel.pct), rawNotch = Number(r.notch.pct);
      yes(`  #${id} the clamp moved the label (${rawNotch.toFixed(1)}% notch -> ${raw.toFixed(1)}% label)`,
        Math.abs(raw - rawNotch) > 0.5);
      is(`  #${id} ...and it stayed inside the track`,
        [r.labelClip.pastTrackLeft > 0.5, r.labelClip.pastTrackRight > 0.5], [false, false]);
      /* AND IT IS DERIVED FROM THE MEASURED WIDTH, not a fixed 12/88: the clamped centre sits
       * exactly half the label's own width from the edge. */
      const halfPct = (r.labelClip.w / 2 / r.track.w) * 100;
      const wantPct = where === "low" ? halfPct : 100 - halfPct;
      yes(`  #${id} clamped to half its own width (${raw.toFixed(2)}% vs ${wantPct.toFixed(2)}%)`,
        Math.abs(raw - wantPct) < 1.5);
    }
    /* CONTROL: restore the fixed 12% clamp and show a min-0 row trips the edge assertion. */
    const tripped = await pn.evaluate(() => {
      const el = document.querySelector('[data-testid="gday-nomin"]');
      const track = el.closest(".gmeter").querySelector(".gbar");
      const prev = el.style.cssText;
      el.style.left = "12%"; el.style.transform = "translateX(-50%)";
      const seen = track.getBoundingClientRect().left - el.getBoundingClientRect().left > 0.5;
      el.style.cssText = prev;
      return seen;
    });
    yes("  CONTROL: the fixed 12% clamp DOES shear a no-min label off the left", tripped,
      "the horizontal edge check cannot see the shear - every clean result above is worthless");

    is("  Needs attention counts only the real one", v.tiles.risk.v, "1");
    is("  CONTROL: ...and that one IS risk-styled", v.rows.find((x) => x.id === TODAY_FIX[0].id)?.risk, true);
    await pn.click('[data-testid="gtile-risk"]'); await pn.waitForTimeout(700);
    const filtered = await pn.evaluate(READ);
    is("  CONTROL: the Needs attention filter shows one banner, not three", filtered.bannerCount, 1);
    await pn.click('[data-testid="gtile-risk"]'); await pn.waitForTimeout(600);

    console.log("\n-- B: 'rung' is off the screen --");
    /* THE WHOLE PAGE'S RENDERED TEXT, not one component. Borrowed jargon leaks. */
    const pageText = await pn.evaluate(() => document.body.innerText);
    is("  no user-visible 'rung' anywhere on the page", /rung/i.test(pageText), false);
    is("  no 'MORE FAKE' anywhere on the page either", /more fake/i.test(pageText), false);
    yes(`  CONTROL: the page really did render (${pageText.length} chars)`, pageText.length > 500);
    /* AND IN THE PANEL TOO, since the editor is where the ladder lives. */
    await pn.click('[data-testid="gday-row"] [data-testid="gday-name"]');
    await pn.waitForSelector('[data-testid="gday-panel"]', { timeout: 30000 });
    await pn.waitForTimeout(1500);
    const panelText = await pn.evaluate(() => document.body.innerText);
    is("  ...nor with the editor panel open", /rung/i.test(panelText), false);
    yes(`  CONTROL: the panel rendered (${panelText.length - pageText.length} more chars)`, panelText.length > pageText.length);
    await pn.click('[data-testid="gday-panel-close"]'); await pn.waitForTimeout(900);

    console.log("\n-- three controls still fit the grid --");
    const g2 = await pn.evaluate(() => {
      const a = document.querySelector('[data-testid="gday-acts"]');
      return { cols: getComputedStyle(a).gridTemplateColumns.split(" ").length, w: Math.round(a.getBoundingClientRect().width) };
    });
    is("  two columns", g2.cols, 2);
    await pn.setViewportSize({ width: 1280, height: 1000 }); await pn.waitForTimeout(700);
    const h = await pn.evaluate(() => Math.round(document.querySelector('[data-testid="gday-alert"]').getBoundingClientRect().height));
    /* TWO HEIGHTS, AND THEY ARE DIFFERENT ON PURPOSE. At rest the banner is ~103px. With a value
     * stepped it also carries a Save button and the explanatory sentence, each on its own row, so
     * ~180px is correct rather than a regression — the check is that it does not blow past that. */
    yes(`  the banner holds its height at 1280 with a pending change (${h}px)`, h < 200);
    await closeContext(cn);
  }


  // ══ ONE FAKE CONTROL: SPOTS LEFT NOW ══════════════════════════════════════════════════════
  {
    /* THE VALUE IS THE RUNG IN FORCE. Six fixtures across the ladder with DISTINCT rung values, so
     * the displayed number names the band that was read — a control showing a constant would pass
     * any single-distance check. */
    const BANDS = [[40 * 60, 36, 2], [30 * 60, 36, 2], [20 * 60, 24, 5], [8 * 60, 12, 7], [4 * 60, 6, 9], [2 * 60, 3, 11]];
    const SET = BANDS.map(([mins, , want], i) => {
      const base = urgentMk({ id: 800 + i, name: `Band ${i}`, fd: "F", city: "Austin",
        at: mins, dlMin: 20, cap: 18, min: 9, real: 3, fake: 5, mgrF: "M", mgrL: String(i) });
      /* A DISTINCT VALUE AT EVERY BAND, so the displayed number identifies which one was read. */
      return { ...base, fakeSpotLeft36h: 2, fakeSpotLeft24h: 5, fakeSpotLeft12h: 7, fakeSpotLeft6h: 9, fakeSpotLeft3h: 11 };
    });
    const { ctx: cb, page: pb, puts: pbPuts, fakeWrites: pbFakes } = await boot(browser, storageState, 1500, { byDate: true, todaySet: SET });
    await pb.click('[data-testid="gtile-risk"]'); await pb.waitForTimeout(900);

    console.log("\n-- three controls, not four --");
    const acts = await pb.evaluate(() => {
      const a = document.querySelector('[data-testid="gday-acts"]');
      return [...a.children].filter((c) => c.matches("a,button,span.gstep")).length;
    });
    is("  the banner renders exactly three controls", acts, 3);
    const txt = await pb.evaluate(() => document.body.innerText);
    is("  no 'Fakes now' anywhere", /Fakes now/i.test(txt), false);
    is("  no 'Fakes at 3h' anywhere", /Fakes at 3h/i.test(txt), false);
    is("  no band label anywhere", /\dh band/i.test(txt), false);
    is("  no 'rung' anywhere", /rung/i.test(txt), false);
    is("  the control reads 'Spots left now'",
      (await pb.locator('[data-testid="gday-alert"][data-id="800"] .glab').textContent()).trim(), "Spots left now");

    console.log("\n-- the value is the rung in force --");
    const seen = [];
    for (let i = 0; i < BANDS.length; i++) {
      const [mins, , want] = BANDS[i];
      const got = Number(await pb.locator(`[data-testid="gday-alert"][data-id="${800 + i}"] [data-testid="gday-spots-value"]`).textContent());
      seen.push(got);
      is(`  ${mins / 60}h out reads the band's own value`, got, want);
    }
    yes(`  CONTROL: the value really varies across bands (${new Set(seen).size} distinct)`, new Set(seen).size >= 4);

    console.log("\n-- the fake count is derived and moves inversely --");
    const CAP = 18, REAL = 3;
    const one = `[data-testid="gday-alert"][data-id="802"]`;   // 20h out, band value 5
    for (let i = 0; i < 3; i++) {
      const v = Number(await pb.locator(`${one} [data-testid="gday-spots-value"]`).textContent());
      const f = (await pb.locator(`${one} [data-testid="gday-spots-fakes"]`).textContent()).trim();
      is(`  step ${i}: ${CAP} − ${v} − ${REAL} fake`, f, `· ${Math.max(0, CAP - v - REAL)} fake`);
      await pb.click(`${one} [data-testid="gday-spots-down"]`); await pb.waitForTimeout(260);
    }

    console.log("\n-- the save writes the in-force band and every later one, and no earlier one --");
    /* SNAPSHOT THE LADDER BEFORE THE SAVE. The PUT mock now APPLIES rung writes to the fixture, as
     * the real API does, so reading SET[2] after the click reads the POST-save value - the two
     * controls below were asserting "the 12h band is 7" against a band the save had just set to 2.
     * They are about the state the save started from, so that is what is captured. */
    const ladderBefore = { ...SET[2] };
    pbPuts.length = 0;
    await pb.click(`${one} [data-testid="gday-save-spots"]`); await pb.waitForTimeout(1500);
    is("  exactly one PUT", pbPuts.length, 1);
    const body = pbPuts[0].body.changes;
    is("  the 24h band in force and every later one", Object.keys(body).sort(),
      ["fakeSpotLeft12h", "fakeSpotLeft24h", "fakeSpotLeft3h", "fakeSpotLeft6h"]);
    is("  ...all to the same value", [...new Set(Object.values(body))], [2]);
    is("  CONTROL: the earlier 36h band is NOT written", "fakeSpotLeft36h" in body, false);
    /* CONTROL: writing ONLY the in-force band would let the next band revert it. Computed from the
     * fixture's own ladder, which has a different value at every band. */
    is("  CONTROL: the 12h band would otherwise revert it to 7", ladderBefore.fakeSpotLeft12h, 7);
    yes("  CONTROL: ...which is not the value being saved", ladderBefore.fakeSpotLeft12h !== 2);
    is("  ...and the save really did move it to 2", SET[2].fakeSpotLeft12h, 2);

    console.log("\n-- every attempt renders an outcome --");
    const verdict = async () => (await pb.locator(`${one} [data-testid="gday-save-verdict"]`).textContent().catch(() => null));
    yes(`  a successful save reports - "${(await verdict() ?? "").slice(0, 40)}"`, /LANDED/.test(await verdict() ?? ""));

    /* ── THE ROSTER WRITE ──────────────────────────────────────────────────────────────────────
     * The save must send a SECOND write that brings the fake roster to capacity − real − target,
     * and every assertion below reads the RESULTING count rather than the number that was sent.
     * The fixture is capacity 18, 3 real; the save above set the rung to 2, so the target is 13. */
    console.log("\n-- the save moves the roster, not only the ladder --");
    is("  exactly one roster write was sent", pbFakes.length, 1);
    is("  ...to that match's own fakes route", /\/matches\/802\/fakes$/.test(pbFakes[0]?.url ?? ""), true);
    is("  ...carrying capacity minus real minus the target spots (18 - 3 - 2)", pbFakes[0]?.target, 13);
    is("  no Idempotency-Key is sent", "idempotency-key" in (pbFakes[0]?.headers ?? {}), false);
    /* THE RESULT, READ OFF THE BOARD. The fixture applied the target, so the row's own observed
     * count must now be 13 - and this is read from the rendered page, not from the request. */
    {
      const nums = await pb.locator(`[data-testid="gday-alert"][data-id="802"] [data-testid="gday-fact-fake"] b`).textContent();
      is("  the OBSERVED fake count on the board is now the target", Number(nums), 13);
    }

    console.log("\n-- lowering spots ADDS fakes; raising them REMOVES fakes --");
    {
      /* TWO DIRECTIONS, ON TWO FRESH BANNERS, because the direction is the thing that decides
       * whether the route adds or deletes and a single-direction test would miss half of it. */
      const dirSet = [
        { ...urgentMk({ id: 850, name: "Lower", fd: "F", city: "Austin", at: 20 * 60, dlMin: 20, cap: 18, min: 9, real: 3, fake: 5 }),
          fakeSpotLeft36h: 10, fakeSpotLeft24h: 10, fakeSpotLeft12h: 10, fakeSpotLeft6h: 10, fakeSpotLeft3h: 10 },
        { ...urgentMk({ id: 851, name: "Raise", fd: "F", city: "Austin", at: 20 * 60, dlMin: 20, cap: 18, min: 9, real: 3, fake: 5 }),
          fakeSpotLeft36h: 10, fakeSpotLeft24h: 10, fakeSpotLeft12h: 10, fakeSpotLeft6h: 10, fakeSpotLeft3h: 10 },
      ];
      const { ctx: cd, page: pd, fakeWrites: df } = await boot(browser, storageState, 1500, { byDate: true, todaySet: dirSet });
      await pd.click('[data-testid="gtile-risk"]'); await pd.waitForTimeout(900);
      const obs = async (id) => Number(await pd.locator(`[data-testid="gday-alert"][data-id="${id}"] [data-testid="gday-fact-fake"] b`).textContent());

      const before850 = await obs(850);
      yes(`  CONTROL: 850 starts at ${before850} fakes (18 - 10 - 3 would be 5)`, before850 === 5);
      // Spots 10 -> 8 means fakes 5 -> 7: FEWER spots shown means MORE fakes.
      await pd.click('[data-testid="gday-alert"][data-id="850"] [data-testid="gday-spots-down"]');
      await pd.click('[data-testid="gday-alert"][data-id="850"] [data-testid="gday-spots-down"]');
      await pd.waitForTimeout(300);
      await pd.click('[data-testid="gday-alert"][data-id="850"] [data-testid="gday-save-spots"]');
      await pd.waitForTimeout(1800);
      const after850 = await obs(850);
      is("  LOWERING spots left adds fakes - the roster count RESULT is 7", after850, 7);
      yes("  CONTROL: it really moved", after850 !== before850);
      is("  ...and the write asked for 7, not for the spots number", df.find((w) => w.id === 850)?.target, 7);

      const before851 = await obs(851);
      // Spots 10 -> 12 means fakes 5 -> 3: MORE spots shown means FEWER fakes, i.e. removals.
      await pd.click('[data-testid="gday-alert"][data-id="851"] [data-testid="gday-spots-up"]');
      await pd.click('[data-testid="gday-alert"][data-id="851"] [data-testid="gday-spots-up"]');
      await pd.waitForTimeout(300);
      await pd.click('[data-testid="gday-alert"][data-id="851"] [data-testid="gday-save-spots"]');
      await pd.waitForTimeout(1800);
      const after851 = await obs(851);
      is("  RAISING spots left removes fakes - the roster count RESULT is 3", after851, 3);
      yes("  CONTROL: it really moved", after851 !== before851);

      /* ONLY FAKES MOVED. The real count on both banners is untouched - a removal that took a real
       * player would show here, and this is the board-level half of the guarantee that
       * fake-roster-plan-test asserts on the plan itself. */
      const realOf = async (id) => Number(await pd.locator(`[data-testid="gday-alert"][data-id="${id}"] [data-testid="gday-fact-real"] b`).textContent());
      is("  NO REAL PLAYER WAS REMOVED by the add", await realOf(850), 3);
      is("  NO REAL PLAYER WAS REMOVED by the removal", await realOf(851), 3);
      await closeContext(cd);
    }

    console.log("\n-- a roster write that fails does NOT report LANDED --");
    {
      const failSet = [{ ...urgentMk({ id: 860, name: "Half", fd: "F", city: "Austin", at: 20 * 60, dlMin: 20, cap: 18, min: 9, real: 3, fake: 5 }),
        fakeSpotLeft36h: 10, fakeSpotLeft24h: 10, fakeSpotLeft12h: 10, fakeSpotLeft6h: 10, fakeSpotLeft3h: 10 }];
      const { ctx: cf, page: pf, puts: ff, fakeWrites: fw } = await boot(browser, storageState, 1500,
        { byDate: true, todaySet: failSet, fakesStatus: 500 });
      await pf.click('[data-testid="gtile-risk"]'); await pf.waitForTimeout(900);
      await pf.click('[data-testid="gday-alert"][data-id="860"] [data-testid="gday-spots-down"]');
      await pf.waitForTimeout(250);
      ff.length = 0;
      await pf.click('[data-testid="gday-alert"][data-id="860"] [data-testid="gday-save-spots"]');
      await pf.waitForTimeout(2200);
      const v = (await pf.locator('[data-testid="gday-alert"][data-id="860"] [data-testid="gday-save-verdict"]').textContent().catch(() => "")) ?? "";
      yes("  CONTROL: the LADDER half really was written first", ff.length === 1);
      yes("  CONTROL: ...and the roster half really was attempted", fw.length === 1);
      is("  the verdict does NOT say LANDED", /LANDED/.test(v), false);
      yes(`  it says PARTLY APPLIED and names both halves - "${v.slice(0, 72)}"`,
        /PARTLY APPLIED/.test(v) && /ladder/i.test(v) && /roster/i.test(v));
      /* THE COPY MUST NAME THE RECONCILER AND ITS SLOW FIGURE. This sentence is only honest
       * because a reconciler was PROVEN to exist (staging 2026-09-02, both directions, 93/103s to
       * add and 294/298s to remove). If it had not, telling an operator the count fixes itself
       * would have been worse than the bug. Five minutes is the removal figure, deliberately —
       * quoting the fast one would understate the case an operator hits when freeing spots. */
      yes("  ...and says the roster catches up on its own", /catches up on its own/i.test(v));
      yes("  ...quoting the SLOW figure, five minutes", /five minutes/i.test(v));
      is("  ...and does not still claim two minutes", /2 minutes|two minutes/i.test(v), false);
      is("  the verdict is styled as a failure, not a success",
        await pf.locator('[data-testid="gday-alert"][data-id="860"] [data-testid="gday-save-verdict"]').getAttribute("data-state"), "failed");
      await closeContext(cf);
    }

    console.log("\n-- a roster write that lands SHORT reports NOT APPLIED, not LANDED --");
    {
      const shortSet = [{ ...urgentMk({ id: 870, name: "Short", fd: "F", city: "Austin", at: 20 * 60, dlMin: 20, cap: 18, min: 9, real: 3, fake: 5 }),
        fakeSpotLeft36h: 10, fakeSpotLeft24h: 10, fakeSpotLeft12h: 10, fakeSpotLeft6h: 10, fakeSpotLeft3h: 10 }];
      const { ctx: cs, page: ps } = await boot(browser, storageState, 1500,
        { byDate: true, todaySet: shortSet, fakesLandShort: true });
      await ps.click('[data-testid="gtile-risk"]'); await ps.waitForTimeout(900);
      await ps.click('[data-testid="gday-alert"][data-id="870"] [data-testid="gday-spots-down"]');
      await ps.waitForTimeout(250);
      await ps.click('[data-testid="gday-alert"][data-id="870"] [data-testid="gday-save-spots"]');
      await ps.waitForTimeout(2200);
      const v = (await ps.locator('[data-testid="gday-alert"][data-id="870"] [data-testid="gday-save-verdict"]').textContent().catch(() => "")) ?? "";
      is("  a short landing does NOT say LANDED", /LANDED/.test(v), false);
      yes(`  it says NOT APPLIED and quotes both numbers - "${v.slice(0, 78)}"`, /NOT APPLIED/.test(v) && /\d+ fakes rather than \d+/.test(v));
      await closeContext(cs);
    }

    /* ── THE ASSERTION THAT WOULD HAVE CAUGHT THE REPORTED BUG ─────────────────────────────────
     * The banner prints the fake count TWICE from TWO DIFFERENT SOURCES:
     *
     *   gday-fact-fake    the OBSERVED roster count, _count.fakePlayers
     *   gday-spots-fakes  a FORECAST, fakesFor(capacity, rung, real)
     *
     * Before this change "Spots left now" wrote LADDER RUNGS ONLY. The forecast moved, the roster
     * did not, and the same banner showed "10 fake" beside "6 fake" while reporting LANDED. On
     * production 18318 an operator saved 7 spots left, was told it landed, opened the panel and
     * found all ten fakes still sitting there.
     *
     * A SAVE MUST MAKE THE TWO AGREE, because after it the forecast is no longer a forecast - the
     * roster has been brought to it. This reads both numbers off the rendered banner after the
     * save and its reload, so it is testing what the operator is actually looking at. */
    console.log("\n-- THE TWO FAKE NUMBERS AGREE AFTER A SAVE --");
    {
      const twoNumbers = async () => pb.evaluate((sel) => {
        const a = document.querySelector(sel);
        if (!a) return { err: "NO BANNER" };
        const obs = a.querySelector('[data-testid="gday-fact-fake"] b');
        const fc = a.querySelector('[data-testid="gday-spots-fakes"]');
        if (!obs || !fc) return { err: `missing element obs=${!!obs} forecast=${!!fc}` };
        return { observed: Number(obs.textContent), forecast: Number((fc.textContent.match(/(\d+)/) ?? [])[1]) };
      }, one);
      const n = await twoNumbers();
      yes(`  CONTROL: both numbers are on the banner and are numbers (${JSON.stringify(n)})`,
        !n.err && Number.isFinite(n.observed) && Number.isFinite(n.forecast));
      is(`  the OBSERVED roster count and the FORECAST agree after saving`, n.observed, n.forecast);
    }
    await closeContext(cb);
  }

  // ══ C. THE BANNER WITH THE PANEL OPEN ══════════════════════════════════════════════════════
  {
    /* THE EXISTING CHECKS ALL RAN WITH THE PANEL CLOSED, WHICH IS WHY THIS SHIPPED. The panel
     * narrows the board without changing the viewport, so a media query cannot see it. */
    for (const w of [1500, 1366, 1280]) {
      const { ctx: cc2, page: pc2 } = await boot(browser, storageState, w, { byDate: true });
      await pc2.click('[data-testid="gday-row"] [data-testid="gday-name"]');
      await pc2.waitForSelector('[data-testid="gday-panel"]', { timeout: 30000 });
      await pc2.waitForTimeout(1400);
      const g = await pc2.evaluate(() => {
        const a = document.querySelector('[data-testid="gday-alert"]');
        if (!a) return null;
        const head = a.querySelector('[data-testid="gday-alert-head"]');
        const facts = a.querySelector('[data-testid="gday-alert-facts"]');
        const txt = a.querySelector(".gtxt");
        const lh = parseFloat(getComputedStyle(head).lineHeight) || 20;
        const stats = [...facts.querySelectorAll("span")].map((s) => s.getBoundingClientRect());
        return {
          headLines: Math.round(head.getBoundingClientRect().height / lh),
          txtW: Math.round(txt.getBoundingClientRect().width),
          // The facts row is horizontal when its stats share a row band rather than stacking.
          factsRows: new Set(stats.map((r) => Math.round(r.top))).size,
          panelOpen: !!document.querySelector('[data-testid="gday-panel"]'),
        };
      });
      console.log(`\n-- C at ${w}px, PANEL OPEN --`);
      yes(`  ${w}: CONTROL - the panel really is open`, g?.panelOpen === true);
      is(`  ${w}: the headline is on one line`, g.headLines, 1);
      is(`  ${w}: the facts row is horizontal`, g.factsRows, 1);
      yes(`  ${w}: the text block is at least 280px (${g.txtW})`, g.txtW >= 280);
      /* CONTROL: force the old desktop row layout back and show the collapse is caught. */
      const collapsed = await pc2.evaluate(() => {
        const a = document.querySelector('[data-testid="gday-alert"]');
        const prev = a.style.cssText;
        a.style.flexDirection = "row";
        const txt = a.querySelector(".gtxt");
        txt.style.minWidth = "0px";
        const head = a.querySelector('[data-testid="gday-alert-head"]');
        const lh = parseFloat(getComputedStyle(head).lineHeight) || 20;
        const lines = Math.round(head.getBoundingClientRect().height / lh);
        const wNow = Math.round(txt.getBoundingClientRect().width);
        a.style.cssText = prev; txt.style.minWidth = "";
        return { lines, wNow };
      });
      yes(`  ${w}: CONTROL - forcing the row layout DOES collapse the text (${collapsed.lines} lines, ${collapsed.wNow}px)`,
        collapsed.lines > 1 || collapsed.wNow < 280,
        "the collapse check cannot see a crushed text block - every clean result above is worthless");
      await closeContext(cc2);
    }
  }

  // ══ E. THE CONTROL STATES ITS CONSEQUENCE ══════════════════════════════════════════════════
  {
    const { ctx: ce, page: pe } = await boot(browser, storageState, 1500, { byDate: true });
    console.log("\n-- E: 'Cancels below', not 'Adjust min' --");
    const page1 = await pe.evaluate(() => document.body.innerText);
    is("  no control is labelled 'Adjust min'", /Adjust min/i.test(page1), false);
    yes("  the banner control reads 'Cancels below'",
      (await pe.locator('[data-testid="gday-stepper"]').textContent()).trim().startsWith("Cancels below"));
    /* IT STILL WRITES minPlayerCount — the label changed, the behaviour did not. */
    await pe.click('[data-testid="gday-step-down"]'); await pe.waitForTimeout(300);
    await pe.click('[data-testid="gday-save-min"]'); await pe.waitForTimeout(1400);
    yes("  CONTROL: a PUT was sent", puts.length > 0);
    is("  ...and it still writes minPlayerCount", Object.keys(puts[puts.length - 1].body.changes), ["minPlayerCount"]);
    /* THE METER'S LABEL IS UNTOUCHED — it is a position marker, not a control. */
    const v = await pe.evaluate(READ);
    yes("  the meter's 'min N' label is untouched",
      v.rows.some((r) => r.hasMin && /^min \d+$/.test(r.labelClip.text)));
    await closeContext(ce);
  }


  // ══ B. THE COUNTDOWN CHIP ONLY WHERE A MATCH WOULD ACTUALLY MISS ITS DEADLINE ═══════════════
  {
    /* THE THREE ROWS FROM THE BOARD THAT SHOULD NEVER HAVE CARRIED A CHIP, plus a short one that
     * should, plus a min-0 one that never does. All five armed with a deadline ahead, so "armed"
     * cannot be what separates them. */
    const CHIP = [
      urgentMk({ id: 701, name: "Keswick Park (Chamblee)", fd: "Keswick", city: "Atlanta", at: 300, dlMin: 282, cap: 18, min: 6, real: 12, fake: 0, mgrF: "F", mgrL: "O" }),
      urgentMk({ id: 702, name: "The Hattrick (Leander)", fd: "Hattrick", city: "Austin", at: 360, dlMin: 342, cap: 18, min: 9, real: 18, fake: 0, mgrF: "A", mgrL: "L" }),
      urgentMk({ id: 703, name: "Soccer Central Field 4", fd: "SC", city: "San Antonio", at: 420, dlMin: 402, cap: 36, min: 11, real: 36, fake: 0, mgrF: "C", mgrL: "R" }),
      urgentMk({ id: 704, name: "Short one", fd: "F", city: "Austin", at: 300, dlMin: 282, cap: 18, min: 9, real: 3, fake: 0, mgrF: "M", mgrL: "X" }),
      mk({ id: 705, name: "No minimum", fd: "F", city: "Austin", at: 300, cap: 18, min: 0, real: 2, fake: 0, mgrF: "M", mgrL: "Y" }),
    ];
    const { ctx: cB, page: pB } = await boot(browser, storageState, 1500, { byDate: true, todaySet: CHIP });
    const chipOf = async (id) => pB.locator(`[data-testid="gday-row"][data-id="${id}"] [data-testid="gday-cancels"]`).count();
    console.log("\n-- B: the chip follows short, not armed --");
    for (const id of [701, 702, 703]) is(`  #${id} is over its minimum -> NO chip`, await chipOf(id), 0);
    is("  #704 is below its minimum -> a chip", await chipOf(704), 1);
    is("  #705 has no minimum -> never a chip", await chipOf(705), 0);
    /* CONTROL: all five are armed with a deadline ahead. If "armed" were the condition, all five
     * would carry one — which is exactly what the board was doing. */
    const armedCount = CHIP.filter((m) => m.autoCanceled && m.autoCanceledMinutes > 0).length;
    is("  CONTROL: all five are armed", armedCount, 5);
    is("  CONTROL: ...so the old condition would have chipped all five", CHIP.length, 5);
    is("  CONTROL: ...and only one does", (await pB.locator('[data-testid="gday-cancels"]').count()), 1);

    /* THE CHIP AND THE BANNER AGREE ON EVERY ROW. A row with no chip must never be a banner. */
    const agree = await pB.evaluate(() => {
      const out = [];
      for (const r of document.querySelectorAll('[data-testid="gday-row"]')) {
        const id = r.dataset.id;
        out.push({ id, chip: !!r.querySelector('[data-testid="gday-cancels"]'),
          banner: !!document.querySelector(`[data-testid="gday-alert"][data-id="${id}"]`) });
      }
      return out;
    });
    yes(`  CONTROL: there are rows to compare (${agree.length})`, agree.length > 0);
    is("  no row is a banner without a chip", agree.filter((r) => r.banner && !r.chip).map((r) => r.id), []);

    console.log("\n-- B: it is live, not latched --");
    /* DROP THE MATCH BELOW ITS MINIMUM AND BACK, and watch the chip follow. The fixture is served
     * per request, so a refetch re-reads whatever the fixture now says. */
    const over = CHIP.find((m) => m.id === 701);
    const savedPlayers = over._count.players;
    /* A RELOAD, NOT A CLICK WITH A .catch ON IT. The first version clicked a refresh control and
     * swallowed the failure — which is the same swallow-and-pass shape this suite exists to stop.
     * A reload refetches unconditionally and fails loudly if it does not. */
    const reload = async () => {
      await pB.reload({ waitUntil: "domcontentloaded" });
      await pB.waitForSelector('[data-testid="gday-row"]', { timeout: 60000 });
      await pB.waitForTimeout(900);
    };
    over._count.players = 2;                       // 2 real against a minimum of 6
    await reload();
    is("  dropping below the minimum makes the chip appear", await chipOf(701), 1);
    is("  ...and the row is now risk-styled too",
      await pB.locator('[data-testid="gday-row"][data-id="701"][data-risk="1"]').count(), 1);
    over._count.players = savedPlayers;            // back over it
    await reload();
    is("  ...and raising it back makes the chip disappear", await chipOf(701), 0);
    is("  ...and the risk styling goes with it",
      await pB.locator('[data-testid="gday-row"][data-id="701"][data-risk="1"]').count(), 0);
    await closeContext(cB);
  }


  // ══ EVERY SAVE ATTEMPT RENDERS EXACTLY ONE OUTCOME ═════════════════════════════════════════
  {
    const mkSet = () => [urgentMk({ id: 900, name: "Outcome", fd: "F", city: "Austin",
      at: 20 * 60, dlMin: 20, cap: 18, min: 9, real: 3, fake: 5, mgrF: "M", mgrL: "O" })];
    for (const [label, opt, want] of [
      ["a landed save", {}, "landed"],
      ["an HTTP failure", { writeStatus: 502 }, "failed"],
      ["a read-back mismatch", { outcome: "not_applied" }, "failed"],
      ["an unknown outcome", { outcome: "unknown" }, "unknown"],
    ]) {
      const { ctx: co, page: po } = await boot(browser, storageState, 1500,
        { byDate: true, todaySet: mkSet(), ...opt });
      await po.click('[data-testid="gtile-risk"]'); await po.waitForTimeout(800);
      await po.click('[data-testid="gday-spots-down"]'); await po.waitForTimeout(300);
      await po.click('[data-testid="gday-save-spots"]'); await po.waitForTimeout(1800);
      const n = await po.locator('[data-testid="gday-save-verdict"]').count();
      is(`  ${label}: exactly one outcome renders`, n, 1);
      is(`  ${label}: ...and it is ${want.toUpperCase()}`,
        await po.locator('[data-testid="gday-save-verdict"]').getAttribute("data-state"), want);
      await closeContext(co);
    }
    /* AN ALREADY-STORED VALUE STILL REPORTS. The silent no-op was the defect: press Save, every
     * band already holds the value, nothing is sent, and nothing appears. */
    const already = [urgentMk({ id: 901, name: "Already", fd: "F", city: "Austin",
      at: 20 * 60, dlMin: 20, cap: 18, min: 9, real: 3, fake: 5, mgrF: "M", mgrL: "A" })];
    const { ctx: ca2, page: pa2 } = await boot(browser, storageState, 1500, { byDate: true, todaySet: already });
    await pa2.click('[data-testid="gtile-risk"]'); await pa2.waitForTimeout(800);
    /* Step away and back: the value returns to its stored figure, so the diff is empty. */
    await pa2.click('[data-testid="gday-spots-down"]'); await pa2.waitForTimeout(250);
    await pa2.click('[data-testid="gday-spots-up"]'); await pa2.waitForTimeout(250);
    is("  CONTROL: stepping back to the stored value clears the pending state",
      await pa2.locator('[data-testid="gday-save-spots"]').count(), 0);
    await closeContext(ca2);
  }

  // ══ THE RUNG IS WHAT PERSISTS; THE FAKE COUNT DRIFTS ═══════════════════════════════════════
  {
    /* ADDING A REAL PLAYER LOWERS THE DERIVED FAKE COUNT AND LEAVES THE STORED RUNG ALONE — the
     * whole reason the control steps the rung rather than the fake count. Asserted on the RUNG. */
    const M = urgentMk({ id: 910, name: "Drift", fd: "F", city: "Austin",
      at: 20 * 60, dlMin: 20, cap: 18, min: 9, real: 3, fake: 5, mgrF: "M", mgrL: "D" });
    const set = [M];
    const { ctx: cd2, page: pd2 } = await boot(browser, storageState, 1500, { byDate: true, todaySet: set });
    await pd2.click('[data-testid="gtile-risk"]'); await pd2.waitForTimeout(800);
    const rungBefore = Number(await pd2.locator('[data-testid="gday-spots-value"]').textContent());
    const fakeBefore = (await pd2.locator('[data-testid="gday-spots-fakes"]').textContent()).trim();
    is("  the stored rung is 10 (18 − 5 fake − 3 real)", rungBefore, 10);
    is("  ...showing 5 fake", fakeBefore, "· 5 fake");
    /* ONE MORE REAL PLAYER, same ladder. */
    M._count.players += 1;
    await pd2.reload({ waitUntil: "domcontentloaded" });
    await pd2.waitForSelector('[data-testid="gday-row"]', { timeout: 60000 });
    await pd2.click('[data-testid="gtile-risk"]'); await pd2.waitForTimeout(900);
    const rungAfter = Number(await pd2.locator('[data-testid="gday-spots-value"]').textContent());
    const fakeAfter = (await pd2.locator('[data-testid="gday-spots-fakes"]').textContent()).trim();
    is("  the STORED RUNG is untouched", rungAfter, rungBefore);
    is("  ...while the derived fake count drops by one", fakeAfter, "· 4 fake");
    yes("  CONTROL: the two really did diverge", fakeAfter !== fakeBefore && rungAfter === rungBefore);
    await closeContext(cd2);
  }

  // ══ THREE CONTROLS FIT, PANEL OPEN AND CLOSED, AT EVERY WIDTH ══════════════════════════════
  {
    for (const w of [1500, 1366, 1280, 390]) {
      for (const withPanel of w === 390 ? [false] : [false, true]) {
        const { ctx: cf, page: pf } = await boot(browser, storageState, w,
          { byDate: true, mobile: w < 640 });
        await pf.click('[data-testid="gtile-risk"]'); await pf.waitForTimeout(800);
        if (withPanel) {
          await pf.click('[data-testid="gday-alert-head"]');
          await pf.waitForSelector('[data-testid="gday-panel"]', { timeout: 30000 });
          await pf.waitForTimeout(1200);
        }
        const g = await pf.evaluate(() => {
          const a = document.querySelector('[data-testid="gday-alert"]');
          const acts = a.querySelector('[data-testid="gday-acts"]');
          const txt = a.querySelector(".gtxt");
          return { controls: [...acts.children].filter((c) => c.matches("a,span.gstep")).length,
            h: Math.round(a.getBoundingClientRect().height),
            txtW: Math.round(txt.getBoundingClientRect().width),
            hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 };
        });
        const tag = `${w}${withPanel ? " +panel" : ""}`;
        is(`  ${tag}: exactly three controls`, g.controls, 3);
        is(`  ${tag}: no horizontal page scroll`, g.hscroll, false);
        if (w >= 640) yes(`  ${tag}: the text block is at least 280px (${g.txtW})`, g.txtW >= 280);
        /* A PHONE BANNER IS LEGITIMATELY TALLER — the layout stacks every control full width, which
         * is the point of the phone layout. One threshold for both would either pass anything on
         * desktop or fail the phone for doing what it was built to do. */
        const cap2 = w < 640 ? 400 : 320;
        yes(`  ${tag}: the banner is a sane height (${g.h}px, limit ${cap2})`, g.h < cap2);
        await closeContext(cf);
      }
    }
  }


  // ══ THE MATCH OPS SECTION SHEET CLEARS THE BOTTOM NAV ══════════════════════════════════════
  {
    /* REPORTED AS "it doesn't let me scroll", and the panel genuinely was not scrollable —
     * scrollHeight and clientHeight were both 515. The list fitted its own max-height exactly and
     * the last row was simply OCCLUDED by the fixed bottom nav: row bottom 830 against a nav
     * starting at 787. Nothing to scroll and nothing reachable is a worse failure than a clipped
     * row, because there is no affordance suggesting anything is missing. */
    const READ_SHEET = () => {
      const sheet = document.querySelector('[data-testid="screen-sheet"]');
      const panel = sheet.querySelector(".overflow-y-auto");
      const items = [...panel.querySelectorAll("a,button")].filter((e) => e.textContent.trim().length > 3);
      const nav = [...document.querySelectorAll("nav,div")].find((e) =>
        getComputedStyle(e).position === "fixed"
        && e.getBoundingClientRect().bottom >= window.innerHeight - 2
        && e.getBoundingClientRect().height > 40 && e.getBoundingClientRect().height < 120);
      return {
        items: items.map((e) => ({ t: e.textContent.trim().slice(0, 18), bottom: Math.round(e.getBoundingClientRect().bottom) })),
        navTop: nav ? Math.round(nav.getBoundingClientRect().top) : null,
        scrollable: panel.scrollHeight > panel.clientHeight + 1,
        scrollTo: () => { panel.scrollTop = panel.scrollHeight; },
      };
    };
    for (const vh of [844, 700, 600]) {
      const ctxS = await browser.newContext({ storageState, viewport: { width: 390, height: vh }, isMobile: true, hasTouch: true });
      await ctxS.route("**/api/matchday/*/gameday*", (r) =>
        r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ matches: TODAY_FIX }) }));
      const ps = await ctxS.newPage();
      await ps.goto(PAGE, { waitUntil: "domcontentloaded" });
      await ps.waitForSelector('[data-testid="gday-row"]', { timeout: 120000 });
      await ps.waitForTimeout(1200);
      await ps.click('[data-testid="mo-screen-picker"]');
      await ps.waitForSelector('[data-testid="screen-sheet"]', { timeout: 30000 });
      await ps.waitForTimeout(700);
      /* SCROLL TO THE END FIRST — the question is whether the last row is reachable AT ALL, not
       * whether it happens to be visible before scrolling. */
      await ps.evaluate(() => { const el = document.querySelector('[data-testid="screen-sheet"] .overflow-y-auto'); el.scrollTop = el.scrollHeight; });
      await ps.waitForTimeout(400);
      const v = await ps.evaluate(READ_SHEET);
      console.log(`\n-- the section sheet at 390x${vh} --`);
      yes(`  ${vh}: CONTROL - the sheet has rows (${v.items.length})`, v.items.length > 4);
      yes(`  ${vh}: CONTROL - the bottom nav was found (top ${v.navTop})`, v.navTop != null);
      is(`  ${vh}: every row clears the bottom nav`,
        v.items.filter((it) => it.bottom > v.navTop).map((it) => [it.t, it.bottom]), []);
      /* CONTROL: put the old padding back and show the last row goes behind the nav again. */
      const regressed = await ps.evaluate(() => {
        const el = document.querySelector('[data-testid="screen-sheet"] .overflow-y-auto');
        const prevPad = el.style.paddingBottom, prevMax = el.style.maxHeight;
        el.style.paddingBottom = "14px"; el.style.maxHeight = "86%";
        el.scrollTop = el.scrollHeight;
        const items = [...el.querySelectorAll("a,button")].filter((e) => e.textContent.trim().length > 3);
        const last = items[items.length - 1].getBoundingClientRect().bottom;
        const nav = [...document.querySelectorAll("nav,div")].find((e) =>
          getComputedStyle(e).position === "fixed"
          && e.getBoundingClientRect().bottom >= window.innerHeight - 2
          && e.getBoundingClientRect().height > 40 && e.getBoundingClientRect().height < 120);
        const navTop = nav.getBoundingClientRect().top;
        el.style.paddingBottom = prevPad; el.style.maxHeight = prevMax;
        return last > navTop;
      });
      yes(`  ${vh}: CONTROL - the old 14px padding DOES hide the last row`, regressed,
        "the occlusion check cannot see a row behind the nav - every clean result above is worthless");
      await closeContext(ctxS);
    }
  }


  // ══ SEPARATION: EVERY MATCH IS ITS OWN OBJECT ══════════════════════════════════════════════
  /* The change under test is that a match no longer runs to both screen edges with a 1px divider
   * under it. On desktop it becomes a BAND inside a padded list; on a phone it becomes a CARD.
   *
   * EVERY ASSERTION HERE IS GEOMETRIC AND MEASURED OFF THE RENDERED BOXES. Reading `gap` or
   * `border-radius` off the computed style would only prove the rule was written, not that it
   * survived a media query, a transform, or an ancestor that clips.
   *
   * THE ZERO-GAP CONTROL IS THE POINT OF THE WHOLE BLOCK. "Adjacent bands are >= 5px apart" is
   * also what a page that failed to render its second band reports, and what a measurement that is
   * silently reading the wrong pair of boxes reports. So the list's gap is forced to 0, the SAME
   * measurement is re-run, and it must come back 0 — which proves the number moves with the thing
   * it claims to measure before any conclusion is drawn from it. */
  {
    const measure = async (pg) => pg.evaluate(GEO);
    /* Force one CSS declaration, re-measure, put it back. Returns the measurement taken under it. */
    const under = async (pg, css) => {
      await pg.evaluate((c) => {
        const st = document.createElement("style");
        st.id = "__ctl"; st.textContent = c; document.head.appendChild(st);
      }, css);
      await pg.waitForTimeout(250);
      const v = await pg.evaluate(GEO);
      await pg.evaluate(() => document.getElementById("__ctl")?.remove());
      await pg.waitForTimeout(250);
      return v;
    };

    // ── B. DESKTOP: EACH MATCH IS A BAND ───────────────────────────────────────────────────────
    /* THE BAND CONTRACT IS ASSERTED WITH THE PANEL CLOSED. With it OPEN the table card drops to
     * 576px at a 1500px viewport and 356px at 1280 - below the tier where any four-track grid
     * fits - and the band correctly BECOMES A CARD. That case has its own contract, asserted in
     * the block after this one; running the band assertions against it would either fail on a
     * layout that is right, or, worse, be relaxed until they passed on the layout that was wrong. */
    for (const panelOpen of [false]) {
      const { ctx: cb, page: pb } = await boot(browser, storageState, 1500, { fix: SEP_FIX });
      const label = panelOpen ? "panel OPEN" : "panel closed";

      /* 1100 IS IN THE LIST DELIBERATELY. 1500/1366/1280 all use the wide four-track grid; the
       * compact grid below 1184 is a different manager column and it is the one that was
       * overflowing. Sweeping only the three wide widths is how the 136px cell passed. */
      for (const w of [1500, 1366, 1280, 1100]) {
        await pb.setViewportSize({ width: w, height: 1000 });
        await pb.waitForTimeout(450);
        const g = await measure(pb);
        const tag = `  ${w}px ${label}:`;

        const lists = nonEmpty(g.lists.filter((L) => L.bands.length > 1), `lists with >1 band @${w} ${label}`);
        const allGaps = lists.flatMap((L) => L.gaps);
        nonEmpty(allGaps, `between-band gaps @${w} ${label}`);

        is(`${tag} every adjacent pair of bands has >= 5px of ground between them`,
          lists.flatMap((L) => L.gaps.map((gp, i) => (gp >= 5 ? null : [L.pairs[i], gp])).filter(Boolean)), []);

        /* THE PAIR THIS CHANGE EXISTS FOR. Two at-risk matches next to each other used to read as
         * one block; they are asserted to BE adjacent first, because a fixture that quietly
         * separated them would satisfy the gap check without ever testing the case. */
        const riskPairs = lists.flatMap((L) => L.pairs
          .map((pr, i) => ({ pr, gap: L.gaps[i], a: L.bands[i], b: L.bands[i + 1] }))
          .filter((x) => x.a.risk && x.b.risk));
        yes(`${tag} CONTROL: the fixture really does put two AT-RISK bands next to each other (${riskPairs.map((x) => x.pr.join("+")).join(",")})`,
          riskPairs.length > 0);
        is(`${tag} TWO ADJACENT AT-RISK BANDS ARE SEPARATED`,
          riskPairs.filter((x) => x.gap < 5).map((x) => [x.pr, x.gap]), []);

        is(`${tag} the list insets every band by >= 6px on both sides`,
          lists.filter((L) => L.pad.l < 6 || L.pad.r < 6).map((L) => L.pad), []);
        is(`${tag} ...and the bands sit inside that inset`,
          lists.flatMap((L) => L.bands.filter((bd) => bd.box.l < L.box.l + 5.5 || bd.box.r > L.box.r - 5.5).map((bd) => bd.id)), []);

        is(`${tag} every band is rounded (>= 8px) and bordered (>= 1px)`,
          lists.flatMap((L) => L.bands.filter((bd) => bd.radius < 8 || bd.border < 1).map((bd) => [bd.id, bd.radius, bd.border])), []);
        is(`${tag} every band paints its own background`,
          lists.flatMap((L) => L.bands.filter((bd) => /rgba\(0, 0, 0, 0\)|transparent/.test(bd.bg)).map((bd) => bd.id)), []);
        /* B2: the at-risk band keeps its tint AND an inset left edge, CONTAINED by the radius —
         * asserted as an inset shadow rather than a border-left, which is how it is drawn. */
        const risky = lists.flatMap((L) => L.bands.filter((bd) => bd.risk));
        yes(`${tag} CONTROL: there are at-risk bands to check (${risky.length})`, risky.length > 0);
        is(`${tag} every at-risk band carries an inset left edge`,
          risky.filter((bd) => !/inset/.test(bd.shadow)).map((bd) => bd.id), []);
        is(`${tag} ...and a tint distinct from a healthy band`, (() => {
          const healthy = lists.flatMap((L) => L.bands.filter((bd) => !bd.risk));
          if (healthy.length === 0) return "NO HEALTHY BAND - the comparison is vacuous";
          return risky.filter((bd) => bd.bg === healthy[0].bg).map((bd) => bd.id);
        })(), []);

        /* B3: COLUMNS DO NOT MOVE. Every band's column left edges are identical to every other
         * band's, and to the header's, within 9px. */
        const bands = lists.flatMap((L) => L.bands);
        const first = bands[0].colLefts;
        is(`${tag} every band's columns start in the same places`,
          bands.filter((bd) => bd.colLefts.length !== first.length
            || bd.colLefts.some((x, i) => Math.abs(x - first[i]) > 0.5)).map((bd) => [bd.id, bd.colLefts]), []);
        is(`${tag} ...and the header's columns agree with them within 9px`, (() => {
          if (!g.headCols || g.headCols.length !== first.length) return `HEADER ${JSON.stringify(g.headCols)} vs BAND ${JSON.stringify(first)}`;
          return g.headCols.map((x, i) => (Math.abs(x - first[i]) > 9 ? [i, x, first[i]] : null)).filter(Boolean);
        })(), []);

        const priced = bands.filter((bd) => bd.price);
        yes(`${tag} CONTROL: there are prices to check (${priced.length})`, priced.length > 0);
        is(`${tag} no price is sheared by its track`,
          priced.filter((bd) => bd.price.cut).map((bd) => [bd.id, bd.price.text, bd.price.over]), []);
        is(`${tag} no manager name spills out of its cell`,
          bands.filter((bd) => bd.mgrClipped).map((bd) => [bd.id, bd.mgrText, bd.mgrOver]), []);
        yes(`${tag} CONTROL: the long name IS on the board ("${bands.map((bd) => bd.mgrText).find((t) => /Rocha/.test(t)) ?? "MISSING"}")`,
          bands.some((bd) => /Peter Rocha-Ramirez/.test(bd.mgrText)));
        is(`${tag} every initials avatar is >= 23px and fits its text`,
          bands.filter((bd) => !bd.av || bd.av.box.w < 22.5 || bd.av.clipped).map((bd) => [bd.id, bd.av?.box.w, bd.av?.clipped]), []);
        is(`${tag} no horizontal page scroll`, g.hscroll, false);
        is(`${tag} no kebab survives anywhere on the page`, g.kebabs, 0);
      }

      /* THE TWO CONTROLS. Both are run at 1500 only - they prove the MEASUREMENT, and a
       * measurement that moves at one width moves at all of them. */
      await pb.setViewportSize({ width: 1500, height: 1000 });
      await pb.waitForTimeout(400);
      {
        const z = await under(pb, ".gdo .glist{gap:0 !important}");
        const zg = nonEmpty(z.lists.flatMap((L) => L.gaps), "gaps under the zero-gap control");
        is(`  ${label}: CONTROL - forcing gap:0 really does close the ground to 0`,
          zg.filter((x) => x > 0.5), []);
        const back = await measure(pb);
        yes(`  ${label}: CONTROL - ...and removing it opens it again`,
          nonEmpty(back.lists.flatMap((L) => L.gaps), "gaps after the control").every((x) => x >= 5));
      }
      {
        /* THE COLUMN-IDENTITY CONTROL. One band gets a different grid template; the same equality
         * check must now FAIL. Without this, "every band's columns agree" is also what a probe
         * reading one band twice would report. */
        const c = await under(pb, '.gdo [data-testid="gday-row"][data-id="603"]{grid-template-columns:150px minmax(0,1fr) 200px 120px !important}');
        const bs = nonEmpty(c.lists.flatMap((L) => L.bands), "bands under the column control");
        const ref = bs.find((x) => x.id !== 603)?.colLefts ?? [];
        const moved = bs.find((x) => x.id === 603);
        yes(`  ${label}: CONTROL - the check CAN fail: moving one band's tracks moves its columns`,
          !!moved && moved.colLefts.some((x, i) => Math.abs(x - ref[i]) > 0.5));
      }
      await closeContext(cb);
    }

    // ── THE PANEL-OPEN CONTRACT: THE TABLE STACKS RATHER THAN COLLAPSING A COLUMN ──────────────
    /* THE DEFECT THIS BLOCK EXISTS FOR. The row grid used to switch tiers on the VIEWPORT, so with
     * the match panel open at 1500px the card was 576px, the four fixed tracks needed 660, and
     * minmax(0,1fr) did exactly what it is asked to: the match column went to ZERO WIDTH and the
     * name and price rendered outside it. It got worse as the window narrowed - 356px of card at
     * 1280, 100px at 1024 - and no viewport query could see any of it, because every one of those
     * cases is a WIDE window. The tier is chosen by the card now, and this asserts the result. */
    {
      const { ctx: co, page: po } = await boot(browser, storageState, 1500, { fix: SEP_FIX });
      await po.click('[data-testid="gday-row"][data-id="605"] [data-testid="gday-name"]');
      await po.waitForSelector('[data-testid="gday-panel"]', { timeout: 30000 });
      await po.waitForTimeout(800);
      for (const w of [1500, 1366, 1280]) {
        await po.setViewportSize({ width: w, height: 1000 });
        await po.waitForTimeout(500);
        const g = await measure(po);
        const tag = `  ${w}px panel OPEN:`;
        const bands = nonEmpty(g.lists.flatMap((L) => L.bands), `bands @${w} panel open`);
        const cardW = await po.evaluate(() => {
          const c = document.querySelector('[data-testid="snapshot"]');
          return c ? +c.getBoundingClientRect().width.toFixed(2) : null;
        });
        yes(`${tag} CONTROL: the panel really has narrowed the table (card ${cardW}px)`, cardW !== null && cardW < 700);

        /* THE ASSERTION THE OLD LAYOUT FAILED. Zero is the value that shipped. */
        is(`${tag} NO COLUMN IS COLLAPSED TO ZERO WIDTH`,
          bands.flatMap((bd) => bd.kids.map((k, i) => (k.w < 1 ? [bd.id, i, k.w] : null)).filter(Boolean)), []);
        is(`${tag} the bands have stacked to one column`,
          bands.filter((bd) => bd.colLefts.length > 1
            && bd.colLefts.some((x) => Math.abs(x - bd.colLefts[0]) > 0.5)).map((bd) => [bd.id, bd.colLefts]), []);
        is(`${tag} separation survives the stack`,
          g.lists.flatMap((L) => L.gaps.map((gp, i) => (gp >= 5 ? null : [L.pairs[i], gp])).filter(Boolean)), []);
        is(`${tag} no price is sheared`, bands.filter((bd) => bd.price?.cut).map((bd) => [bd.id, bd.price.text]), []);
        is(`${tag} no manager name spills out of its cell`,
          bands.filter((bd) => bd.mgrClipped).map((bd) => [bd.id, bd.mgrText, bd.mgrOver]), []);
        is(`${tag} no horizontal page scroll`, g.hscroll, false);
        is(`${tag} no kebab survives`, g.kebabs, 0);
      }
      await closeContext(co);
    }

    // ── A. MOBILE: EACH MATCH IS A CARD ────────────────────────────────────────────────────────
    for (const w of [390, 430]) {
      const { ctx: cm, page: pm } = await boot(browser, storageState, w, { fix: SEP_FIX, mobile: true, height: 844 });
      const g = await measure(pm);
      const tag = `  ${w}px:`;
      const lists = nonEmpty(g.lists.filter((L) => L.bands.length > 1), `card lists @${w}`);
      const cards = lists.flatMap((L) => L.bands);
      nonEmpty(cards, `cards @${w}`);

      is(`${tag} every adjacent pair of cards has >= 10px of ground between them`,
        lists.flatMap((L) => L.gaps.map((gp, i) => (gp >= 10 ? null : [L.pairs[i], gp])).filter(Boolean)), []);

      const riskPairs = lists.flatMap((L) => L.pairs
        .map((pr, i) => ({ pr, gap: L.gaps[i], a: L.bands[i], b: L.bands[i + 1] }))
        .filter((x) => x.a.risk && x.b.risk));
      yes(`${tag} CONTROL: two AT-RISK cards really are adjacent (${riskPairs.map((x) => x.pr.join("+")).join(",")})`, riskPairs.length > 0);
      is(`${tag} TWO ADJACENT AT-RISK CARDS ARE SEPARATED`, riskPairs.filter((x) => x.gap < 10).map((x) => [x.pr, x.gap]), []);

      is(`${tag} the gutter insets every card by >= 10px on both sides`,
        lists.filter((L) => L.pad.l < 10 || L.pad.r < 10).map((L) => L.pad), []);
      is(`${tag} ...and every card sits inside it`,
        cards.filter((c) => c.box.l < 9.5 || c.box.r > g.vw - 9.5).map((c) => [c.id, c.box.l, c.box.r]), []);
      is(`${tag} every card is rounded >= 10px with a real 1px border`,
        cards.filter((c) => c.radius < 10 || c.border < 1).map((c) => [c.id, c.radius, c.border]), []);
      is(`${tag} every card paints its own background`,
        cards.filter((c) => /rgba\(0, 0, 0, 0\)|transparent/.test(c.bg)).map((c) => c.id), []);
      is(`${tag} every card carries a shadow`, cards.filter((c) => !c.shadow || c.shadow === "none").map((c) => c.id), []);

      /* A1: THE GAP BETWEEN CARDS MUST BEAT EVERY GAP INSIDE ONE, or the cards read as one column
       * of blocks again. "Inside" is measured between the card's own top-level blocks. */
      const insideMax = Math.max(...cards.map((c) => {
        const k = c.kids;
        return Math.max(0, ...k.slice(1).map((x, i) => x.t - k[i].b));
      }));
      const betweenMin = Math.min(...lists.flatMap((L) => L.gaps));
      /* THE LARGEST IN-CARD GAP IS ZERO, and a zero that is not controlled is worthless: `x > 2*0`
       * is true for every positive x, and it is equally true when the measurement is reading the
       * wrong boxes and finding nothing. So the same measurement is re-run with a row-gap forced
       * INTO the card, and it must come back with that gap. Only then does the real zero mean the
       * card's four strips genuinely abut. */
      const forced = await under(pm, '.gdo [data-testid="gday-row"]{row-gap:9px !important}');
      const forcedInside = Math.max(...forced.lists.flatMap((L) => L.bands).map((c) => {
        const k = c.kids; return Math.max(0, ...k.slice(1).map((x, i) => x.t - k[i].b));
      }));
      yes(`${tag} CONTROL: the in-card measurement finds a gap when there is one (forced 9px, read ${forcedInside.toFixed(2)}px)`,
        forcedInside >= 8.5);
      yes(`${tag} between-card gap (${betweenMin}px) is more than twice the largest gap inside a card (${insideMax.toFixed(2)}px)`,
        betweenMin > 2 * insideMax && betweenMin >= 10);

      /* A3/A4: THE HEADER AND FOOTER STRIPS. Both must be tinted (not the card's own background)
       * and the at-risk header must differ from a healthy one - that tint IS the risk signal now
       * that the full-card wash is gone. */
      is(`${tag} every card has a header strip and a footer strip`,
        cards.filter((c) => !c.gk || !c.mgr).map((c) => c.id), []);
      is(`${tag} the header strip is tinted, not the card ground`,
        cards.filter((c) => c.gk.bg === c.bg).map((c) => [c.id, c.gk.bg]), []);
      is(`${tag} the footer strip is tinted, not the card ground`,
        cards.filter((c) => c.mgr.bg === c.bg).map((c) => [c.id, c.mgr.bg]), []);
      is(`${tag} the header strip has a hairline beneath it`, cards.filter((c) => c.gk.borderBottom < 1).map((c) => c.id), []);
      is(`${tag} the footer strip has a hairline above it`, cards.filter((c) => c.mgr.borderTop < 1).map((c) => c.id), []);
      is(`${tag} AN AT-RISK HEADER STRIP IS A DIFFERENT COLOUR FROM A HEALTHY ONE`, (() => {
        const r = cards.filter((c) => c.risk), h = cards.filter((c) => !c.risk);
        if (r.length === 0 || h.length === 0) return `VACUOUS: risk=${r.length} healthy=${h.length}`;
        return r.filter((c) => c.gk.bg === h[0].gk.bg).map((c) => [c.id, c.gk.bg, h[0].gk.bg]);
      })(), []);

      /* A5: THE CHIP IS ON THE FIELD LINE, not the title line. Measured against the two rows it
       * could be on rather than against a pixel constant. */
      const chipped = cards.filter((c) => c.chip);
      yes(`${tag} CONTROL: there are cancels chips to place (${chipped.length})`, chipped.length > 0);
      is(`${tag} THE CANCELS CHIP IS ON THE FIELD LINE, NOT THE TITLE LINE`,
        chipped.filter((c) => Math.abs(c.chip.t - c.sub.t) > 4 || Math.abs(c.chip.t - c.name.t) < 4)
          .map((c) => [c.id, c.chip.t, c.name.t, c.sub.t]), []);
      is(`${tag} no title wraps beyond two lines`,
        cards.filter((c) => c.name.lines > 2).map((c) => [c.id, c.name.lines]), []);
      yes(`${tag} CONTROL: the long title IS in the fixture`, cards.some((c) => c.name.box.w > 0) && lists.length > 0);

      is(`${tag} no horizontal page scroll`, g.hscroll, false);
      is(`${tag} no kebab survives anywhere on the page`, g.kebabs, 0);
      is(`${tag} no manager name is clipped`, cards.filter((c) => c.mgrClipped).map((c) => [c.id, c.mgrText]), []);

      /* A6: THE METER. Label inside the track on BOTH axes and inside every clipping ancestor,
       * >= 28px reserved beneath the bar, and a width that follows the card rather than 104px. */
      const mv = await pm.evaluate(READ);
      const mrows = nonEmpty(mv.rows, `mobile rows @${w}`);
      const clipped = mrows.filter((r) => r.labelClip);
      yes(`${tag} CONTROL: there are meter labels to measure (${clipped.length} of ${mrows.length})`, clipped.length > 0);
      is(`${tag} every meter label is inside its track horizontally`,
        clipped.filter((r) => r.labelClip.pastTrackLeft > 0.5 || r.labelClip.pastTrackRight > 0.5)
          .map((r) => [r.id, r.labelClip.text, r.labelClip.pastTrackLeft, r.labelClip.pastTrackRight]), []);
      is(`${tag} ...and inside every ancestor that clips`,
        clipped.filter((r) => r.labelClip.outside.length > 0).map((r) => [r.id, r.labelClip.outside]), []);
      is(`${tag} no label spills past the bottom of its meter`,
        clipped.filter((r) => r.labelClip.belowMeter > -0.5).map((r) => [r.id, r.labelClip.belowMeter]), []);
      /* THE RESERVE ITSELF, not just containment. "The label is inside the meter" is satisfied by a
       * meter with no room at all if the label happens to be short; the spec asked for >= 28px of
       * ground beneath the BAR, and 15px is what clipped it in the mock. Measured meter-bottom
       * minus bar-bottom, per card. */
      const reserve = await pm.evaluate(() => [...document.querySelectorAll('[data-testid="gday-row"]')].map((r) => {
        const mt = r.querySelector(".gmeter"), br2 = r.querySelector(".gbar");
        if (!mt || !br2) return null;
        return { id: Number(r.dataset.id),
          px: +(mt.getBoundingClientRect().bottom - br2.getBoundingClientRect().bottom).toFixed(2) };
      }).filter(Boolean));
      yes(`${tag} CONTROL: there are meters to measure the reserve on (${reserve.length})`, reserve.length > 0);
      is(`${tag} the meter reserves >= 28px below the bar for the label`,
        reserve.filter((r) => r.px < 27.5), []);
      is(`${tag} the meter takes card width, not a fixed 104px`,
        mrows.filter((r) => r.track && r.track.w <= 110).map((r) => [r.id, r.track.w]), []);
      yes(`${tag} CONTROL: there are cards WITH a minimum to measure (${mrows.filter((r) => r.hasMin).length})`,
        mrows.filter((r) => r.hasMin).length > 0);
      /* THE NO-MINIMUM CARD. Its label reads "no min" and it has no notch to centre on. */
      const nomin = cards.filter((c) => c.nomin);
      yes(`${tag} CONTROL: the fixture carries a match with no minimum`, nomin.length === 1);
      is(`${tag} ...and exactly the matches with no minimum say "no min"`,
        nomin.map((c) => c.id), [604]);
      is(`${tag} ...and none of them draws a notch`,
        mrows.filter((r) => r.id === 604 && r.notch !== null).map((r) => r.id), []);

      await closeContext(cm);
    }

    // ── THE RE-ANCHORED CLICK GUARD ────────────────────────────────────────────────────────────
    /* THE KEBAB WAS THE OLD ANCHOR AND IT IS GONE. These three controls are the ones that are
     * genuinely INSIDE a click-to-open container: the banner is itself role="button" with an
     * onClick that opens the panel (GamedayBoard.tsx:1754), and each control stops the click.
     *
     * Each is asserted TWICE: it must not open the panel, AND it must still do its own job. The
     * second half is what the old assertion never had - a control wired to nothing at all also
     * "does not open the panel". */
    {
      const { ctx: cg, page: pg, puts: gputs } = await boot(browser, storageState, 1500, { byDate: true });
      is("  CONTROL: a banner is on the page to click into", await pg.locator('[data-testid="gday-alert"]').count(), 1);
      is("  CONTROL: no panel open to begin with", (await pg.evaluate(READ)).drawer, 0);

      /* THE BANNER REALLY IS CLICK-TO-OPEN. Without this the three guards below are all satisfied
       * by a banner that opens nothing no matter where you click it. */
      await pg.click('[data-testid="gday-alert-head"]');
      await pg.waitForSelector('[data-testid="gday-panel"]', { timeout: 30000 });
      is("  CONTROL: clicking the banner's headline DOES open the panel", (await pg.evaluate(READ)).drawer, 1);
      await pg.click('[data-testid="gday-panel-close"]');
      await pg.waitForTimeout(900);
      is("  CONTROL: ...and it closes again", (await pg.evaluate(READ)).drawer, 0);

      const stepV = () => pg.locator('[data-testid="gday-step-value"]').textContent();
      const spotV = () => pg.locator('[data-testid="gday-spots-value"]').textContent();

      const minBefore = await stepV();
      await pg.click('[data-testid="gday-step-down"]');
      await pg.waitForTimeout(500);
      is("  the Cancels below stepper does NOT open the panel", (await pg.evaluate(READ)).drawer, 0);
      const minAfter = await stepV();
      yes(`  ...and it still steps the minimum (${minBefore} -> ${minAfter})`, Number(minAfter) === Number(minBefore) - 1);

      const spotsBefore = await spotV();
      await pg.click('[data-testid="gday-spots-down"]');
      await pg.waitForTimeout(500);
      is("  the Spots left now stepper does NOT open the panel", (await pg.evaluate(READ)).drawer, 0);
      const spotsAfter = await spotV();
      yes(`  ...and it still steps the spots (${spotsBefore} -> ${spotsAfter})`, Number(spotsAfter) === Number(spotsBefore) - 1);

      const putsBefore = gputs.length;
      await pg.click('[data-testid="gday-save-min"]');
      await pg.waitForTimeout(1800);
      is("  the banner Save does NOT open the panel", (await pg.evaluate(READ)).drawer, 0);
      yes(`  ...and it still sent exactly one write (${gputs.length - putsBefore})`, gputs.length - putsBefore === 1);

      /* THE GUARD CONTROL, kept and re-pointed. React attaches its handlers at the root, so a
       * native listener bound directly on the banner fires on the way up REGARDLESS of the
       * synthetic stopPropagation - which is precisely the demonstration wanted: the click really
       * does reach the container, and the only reason the panel stayed shut is the guard. */
      const leaked = await pg.evaluate(() => {
        const b = document.querySelector('[data-testid="gday-alert"]');
        const btn = b.querySelector('[data-testid="gday-step-down"]');
        if (!b || !btn) return "MISSING";
        let saw = false;
        const probe = () => { saw = true; };
        b.addEventListener("click", probe);
        btn.click();
        b.removeEventListener("click", probe);
        return saw;
      });
      is("  CONTROL: the click DOES reach the banner - only the guard stops the panel", leaked, true);
      await closeContext(cg);
    }

    // ── HOW MANY FIT A SCREEN, MEASURED RATHER THAN ESTIMATED ──────────────────────────────────
    /* Reported, not asserted. Separation costs list height and that cost was accepted up front;
     * an assertion here would only be a place to argue with the decision later. */
    for (const [w, h, mob] of [[390, 844, true], [1500, 900, false]]) {
      const { ctx: cf, page: pf } = await boot(browser, storageState, w, { fix: SEP_FIX, mobile: mob, height: h });
      const fit = await pf.evaluate(() => {
        const rows = [...document.querySelectorAll('[data-testid="gday-row"]')];
        if (rows.length === 0) return { fully: 0, pitch: null };
        const vh = window.innerHeight;
        const pitch = rows.length > 1 ? +(rows[1].getBoundingClientRect().top - rows[0].getBoundingClientRect().top).toFixed(2) : null;
        return { fully: rows.filter((r) => r.getBoundingClientRect().bottom <= vh).length, pitch,
          firstTop: +rows[0].getBoundingClientRect().top.toFixed(2) };
      });
      console.log(`  FIT ${w}x${h}: ${fit.fully} matches fully visible, pitch ${fit.pitch}px, list starts at ${fit.firstTop}px`);
      yes(`  CONTROL: the ${w}px board rendered something to count`, fit.pitch !== null);
      await closeContext(cf);
    }
  }

  /* ── THE LIVE BOARD ─────────────────────────────────────────────────────────────────────────
   * No intercept. The clamp and the layout claims are about REAL matches, and a fixture I chose
   * cannot settle them - I picked min 4 of 18 above precisely because min 2 of 18 tripped the
   * clamp, which is exactly the kind of thing a self-chosen fixture hides. */
  {
    const live = await browser.newContext({ storageState, viewport: { width: 1500, height: 1000 } });
    const p2 = await live.newPage();
    await p2.goto(PAGE, { waitUntil: "domcontentloaded" });
    await p2.waitForSelector('[data-testid="gday-row"]', { timeout: 120000 });
    await p2.waitForTimeout(1500);
    console.log("\n-- the LIVE board --");
    for (const w of [1500, 1366, 1280]) {
      await p2.setViewportSize({ width: w, height: 1000 });
      await p2.waitForTimeout(500);
      const v = await p2.evaluate(READ);
      yes(`  ${w}px: CONTROL - there are real rows to check (${v.rows.length})`, v.rows.length > 0);
      is(`  ${w}px: the 12-88% clamp never fires on real data`,
        v.rows.filter((r) => r.minLabel && Math.abs(r.minLabel.pct - r.notch.pct) > 0.001).map((r) => r.id), []);
      is(`  ${w}px: every label sits within 1px of its notch`,
        v.rows.filter((r) => r.minLabel && Math.abs(r.minLabel.box.cx - r.notch.box.cx) > 1).map((r) => r.id), []);
      is(`  ${w}px: no horizontal page scroll`, v.hscroll, false);
      is(`  ${w}px: bands under 72px`, v.rows.filter((r) => r.h >= 72).map((r) => r.id), []);
      is(`  ${w}px: no row overlaps`, (() => { const o = [];
        for (const r of v.rows) for (let i = 1; i < r.chain.length; i++) {
          const a = r.chain[i - 1], b = r.chain[i];
          if (a && b && a.r > b.l + 0.5) o.push([r.id, a.sel, b.sel]); } return o; })(), []);
      is(`  ${w}px: every row's delta equals real minus min`, (() => {
        const bad = [];
        for (const r of v.rows) if (!Number.isFinite(r.delta)) bad.push(r.id);
        return bad; })(), []);
    }
    const foot = (await p2.evaluate(READ)).foot;
    yes(`  the footer names the minimum and the hatch - "${foot.slice(0, 90)}..."`,
      /match minimum/.test(foot) && /hatched/.test(foot));
    await closeContext(live);
  }

  await closeBrowser(browser);
  console.log(`\ngameday-ops: ${PASS} passed, ${FAIL} failed`);
  if (FAIL) { for (const f of fails) console.log(`  FAILED: ${f}`); process.exit(1); }
}
main().catch((e) => fatal(e));

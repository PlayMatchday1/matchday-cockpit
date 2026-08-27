import "server-only"; // no-op under --conditions=react-server
// THE NAV BADGES — one request per page, not one per mounted consumer.
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/shared-badge-fetch-test.ts
//
// MEASURED ON A COLD PAGE LOAD, BEFORE: 4× awaiting-count, 2× manager-pay/week, 2×
// partner-dashboards/actionable, 2× app_users — nine requests for four distinct answers, on every
// page in the app. ChatsRail and MatchOpsSectionSheet both live in the internal layout and both
// call the same four hooks; TopNav and MobileBottomNav call two of them again. None of it blocks
// anything on screen, which is exactly why it went unnoticed: the cost is entirely server-side.

import {
  sharedFetch, badgeFetchStats, resetBadgeFetchStats, BADGE_TTL_MS,
} from "../src/lib/sharedBadgeFetch";
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const is = (n: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
const tick = () => new Promise((r) => setTimeout(r, 5));

async function main() {
  console.log("SHARED BADGE FETCH\n");

  // ── 1. FOUR CONSUMERS, ONE REQUEST ─────────────────────────────────────────────────────────
  console.log("four mounted badges asking at once");
  {
    resetBadgeFetchStats();
    let calls = 0;
    const run = async () => { calls++; await tick(); return { count: 7 }; };
    // The real shape: four components mount in the same tick and all ask.
    const got = await Promise.all([sharedFetch("k", run), sharedFetch("k", run), sharedFetch("k", run), sharedFetch("k", run)]);
    is("one network call for four callers", calls, 1);
    is("…and every caller gets the answer", got, [{ count: 7 }, { count: 7 }, { count: 7 }, { count: 7 }]);
    is("…the same object, not four copies of a re-fetch", got.every((g) => g === got[0]), true);
    is("the counter says three were shared", badgeFetchStats().shared, 3);
    is("…and one was real", badgeFetchStats().fetches, 1);
  }

  // ── 2. A LATER MOUNT INSIDE THE TTL COSTS NOTHING ──────────────────────────────────────────
  console.log("\na component mounting a moment later");
  {
    resetBadgeFetchStats();
    let calls = 0;
    const run = async () => { calls++; return { count: 1 }; };
    await sharedFetch("k", run);
    await sharedFetch("k", run);      // after the first resolved, inside the TTL
    is("the second mount reuses the answer", calls, 1);
    is("the TTL is long enough to cover a page's mounts, short enough to stay fresh", BADGE_TTL_MS, 10_000);
  }

  // ── 3. REFRESH STILL WORKS ─────────────────────────────────────────────────────────────────
  console.log("\nrefresh: force bypasses the TTL but still joins a flight");
  {
    resetBadgeFetchStats();
    let calls = 0;
    const run = async () => { calls++; await tick(); return { count: calls }; };
    await sharedFetch("k", run);
    await sharedFetch("k", run, true);
    is("force re-fetches rather than serving the cache", calls, 2);
    /* A BADGE THAT WILL NOT REFRESH ON DEMAND IS WORSE THAN ONE THAT COSTS A REQUEST — but two
     * components pressing refresh in the same tick is still ONE call. */
    calls = 0;
    resetBadgeFetchStats();
    await Promise.all([sharedFetch("k2", run, true), sharedFetch("k2", run, true)]);
    is("two simultaneous refreshes are one call", calls, 1);
  }

  // ── 4. DIFFERENT QUESTIONS ARE NOT COLLAPSED ───────────────────────────────────────────────
  console.log("\nkeys: different questions stay different");
  {
    resetBadgeFetchStats();
    let calls = 0;
    const run = async () => { calls++; return { count: calls }; };
    await Promise.all([sharedFetch("managerPay:2026-08-24", run), sharedFetch("managerPay:2026-08-17", run)]);
    /* MANAGER PAY IS KEYED ON THE WEEK. Two components asking about different weeks are asking
     * different questions; collapsing them would answer one with the other's number. */
    is("two weeks are two calls", calls, 2);
    const lib = readFileSync("src/lib/useManagerPayAttnCount.ts", "utf8");
    if (/sharedFetch\(`managerPay:\$\{week\}`/.test(lib)) ok("the manager-pay key carries the week");
    else bad("the manager-pay key carries the week", "two weeks would share one answer");
  }

  // ── 5. A FAILURE IS NOT CACHED, AND NEVER WEDGES THE SLOT ──────────────────────────────────
  console.log("\nfailure: not cached, and the in-flight slot is always released");
  {
    resetBadgeFetchStats();
    let calls = 0;
    const boom = async () => { calls++; throw new Error("500"); };
    await sharedFetch("k", boom).catch(() => {});
    await sharedFetch("k", boom).catch(() => {});
    is("a failed call is retried, not remembered for the TTL", calls, 2);
    const okRun = async () => ({ count: 3 });
    is("…and a later success still lands", await sharedFetch("k", okRun), { count: 3 });
    // POSITIVE CONTROL: the same key DOES cache when the call succeeds, so the above is not
    // passing because caching is broken outright.
    let n = 0;
    const counted = async () => { n++; return { count: n }; };
    resetBadgeFetchStats();
    await sharedFetch("k3", counted); await sharedFetch("k3", counted);
    is("control — a successful call IS cached", n, 1);
  }

  // ── 6. EVERY BADGE HOOK ACTUALLY USES IT ───────────────────────────────────────────────────
  console.log("\nthe four hooks are wired to it");
  {
    for (const [file, key] of [
      ["src/lib/useCrmAwaitingCount.ts", "crm:awaiting"],
      ["src/lib/useCrmUnreadCount.ts", "crm:unread"],
      ["src/lib/usePartnerDashboardsCount.ts", "partner:actionable"],
      ["src/lib/useManagerPayAttnCount.ts", "managerPay:"],
    ] as const) {
      const src = readFileSync(file, "utf8");
      if (src.includes("sharedFetch(")) ok(`${file.split("/").pop()} shares its request`);
      else bad(`${file.split("/").pop()} shares its request`, "it fetches for itself");
      if (src.includes(key)) ok(`  …under the key ${key}`); else bad(`  …under the key ${key}`);
      if (/refetch = useCallback\(async \(force = false\)/.test(src)) ok("  …and refresh still forces");
      else bad("  …and refresh still forces", "the badge could not be refreshed on demand");
    }
  }

  // ── 7. THE ACTIONABLE ROUTE NO LONGER WALKS PARTNERS ONE AT A TIME ─────────────────────────
  console.log("\nactionable: the partners are independent, so the waiting was the only thing serialised");
  {
    const route = readFileSync("src/app/api/partner-dashboards/actionable/route.ts", "utf8");
    const code = route.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
    if (/await Promise\.all\(\(data \?\? \[\]\)\.map\(/.test(code)) ok("every partner is computed in parallel");
    else bad("every partner is computed in parallel", "4 partners = 8 sequential queries = 4,615ms");
    if (/await Promise\.all\(\[\s*fetchPartnerRows/.test(code)) ok("…and one partner's two reads run together");
    else bad("…and one partner's two reads run together");
    if (!/for \(const p of data \?\? \[\]\) \{[\s\S]{0,900}await fetchPartnerRows/.test(code))
      ok("the sequential for-await loop is gone");
    else bad("the sequential for-await loop is gone", "it is still there");
    // ORDER MUST SURVIVE. byPartner is built positionally and filtered, not pushed from whichever
    // query returned first.
    if (/perPartner\.filter\(\(c\) => c\.total > 0\)/.test(code)) ok("byPartner keeps its original order");
    else bad("byPartner keeps its original order", "the list would reorder run to run");
  }

  // ── 8. THE MOUNT GATE ──────────────────────────────────────────────────────────────────────
  console.log("\nthe frame: a section that reads nothing from g.data renders immediately");
  {
    const frame = readFileSync("src/components/growth/SectionFrame.tsx", "utf8");
    if (/needsGrowthData = true/.test(frame)) ok("the opt-out defaults to the old behaviour");
    else bad("the opt-out defaults to the old behaviour", "every section would change at once");
    if (/if \(needsGrowthData && \(!g\.data \|\| !g\.activePeriod\)\)/.test(frame)) ok("…and only the opted-out sections skip the wait");
    else bad("…only the opted-out sections skip the wait");
    if (/\{period && g\.data && g\.activePeriod && \(/.test(frame)) ok("the period bar waits on its own rather than holding the page");
    else bad("the period bar waits on its own");
    for (const [file, want] of [
      ["src/app/(internal)/lifecycle/data-room/page.tsx", true],
      ["src/app/(internal)/lifecycle/retention/page.tsx", true],
      ["src/app/(internal)/lifecycle/funnel/page.tsx", false],
      ["src/app/(internal)/lifecycle/behavior/page.tsx", false],
      ["src/app/(internal)/lifecycle/revenue-per-player/page.tsx", false],
      ["src/app/(internal)/lifecycle/churn/page.tsx", false],
    ] as [string, boolean][]) {
      const src = readFileSync(file, "utf8");
      const has = /needsGrowthData=\{false\}/.test(src);
      const name = file.split("/").slice(-2)[0];
      if (has === want) ok(`${name}: ${want ? "renders immediately" : "still waits — it reads g.data"}`);
      else bad(`${name}: ${want ? "renders immediately" : "still waits"}`, `needsGrowthData={false} is ${has ? "set" : "absent"}`);
      /* A SECTION THAT SKIPS THE WAIT MUST HANDLE ITS OWN EMPTY STATE — it will now render before
       * anything has arrived, and a panel that assumes data is present would throw. */
      if (has && !/g\.retention \?|authHeaders=\{g\.authHeaders\}/.test(src))
        bad(`${name}: handles its own loading state`, "it renders before any data exists");
    }
    // AND THE PANEL MUST NOT FETCH BEFORE IT HAS A TOKEN. Mounting early exposed this: the first
    // request went out unauthenticated and came back 401, then retried.
    const panel = readFileSync("src/components/growth/DataRoomPanel.tsx", "utf8");
    if (/if \(!Object\.keys\(authHeaders\)\.length\) return;/.test(panel))
      ok("the Data Room waits for a token rather than firing a 401 first");
    else bad("the Data Room waits for a token", "the first request 401s on every cold open");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main();

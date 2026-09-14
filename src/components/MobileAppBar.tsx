"use client";

// THE ONE MOBILE APP BAR. Rendered by AuthGate ABOVE <main>, as a sibling, on every internal route.
//
// ══ IT IS THE ONLY THING THAT PAYS THE NOTCH ═════════════════════════════════════════════════
// It used to live inside <main>, which also paid the inset, so a Dynamic Island phone paid 59px
// twice before the bar's own 44px band. Now <main> pays nothing below the rail breakpoint and this
// pays var(--sat) once. If you are ever tempted to add top padding to a page, this is the thing
// that already did it.
//
// ══ ONE BAR, NEVER TWO ═══════════════════════════════════════════════════════════════════════
// Gameday Ops and the two chat consoles used to render their own instance to get an `actions` slot.
// They publish through usePageChrome now. Two bars on screen at once means something has gone
// wrong, and the suite asserts the count is exactly one.
//
// ══ A ROUTE WITH NO SIBLINGS STILL GETS ONE ══════════════════════════════════════════════════
// With its own name, no chevron, and the title is NOT a button — a control that opens a list of
// one is a control that does nothing. That is what lets <main>'s padding be zero everywhere with
// no per-route branch.

import { useEffect, useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import { useSectionNavValue } from "./SectionNav";
import MatchOpsSectionSheet from "@/app/(internal)/match-ops/MatchOpsSectionSheet";

/* ── THE ROUTES THAT ARE NOT IN A SECTION ─────────────────────────────────────────────────────
 * Home, Data, Docs, Admin and its four, and the odds and ends. They have no sibling screens, so
 * they get a bar with a name and nothing else. Longest prefix wins, so /admin/finance never falls
 * through to /admin. */
const STANDALONE_TITLES: [string, string][] = [
  ["/admin/canned-responses", "Canned Responses"],
  ["/admin/fields", "Fields"],
  ["/admin/reports", "Reports"],
  ["/admin/veo", "Veo"],
  ["/admin", "Admin"],
  ["/data", "Data"],
  ["/docs", "Docs"],
  ["/home", "Home"],
  ["/matchops/checkin", "Check-in"],
  ["/no-access", "No access"],
  ["/sms-log", "SMS log"],
];

export function standaloneTitle(pathname: string): string {
  const hit = STANDALONE_TITLES.filter(([p]) => pathname === p || pathname.startsWith(p + "/"))
    .sort((a, z) => z[0].length - a[0].length)[0];
  return hit ? hit[1] : "Clubhouse";
}

/* ── THE TITLE WAS PRINTED TWICE ──────────────────────────────────────────────────────────────
 * The bar says "Field Pipeline". The page's own H1 then says "Field Pipeline" again, 26px tall,
 * directly underneath. On a phone that band is a repetition, not a heading, and it is the second
 * thing eating the screen after the double inset.
 *
 * SAME STRING, NOT "A HEADING EXISTS". A page whose H1 differs from the bar keeps it — /home's
 * "Building the premier pickup..." is not a duplicate of anything and stays.
 *
 * IT IS DONE IN THE DOM, ON PURPOSE. The alternative is a prop threaded through 53 page components,
 * every one of which is a chance to get it wrong, to fix one band of whitespace. This is one place,
 * it is reversible on every render, and it only ever hides an element whose text it has compared.
 * The description line and the stat chips are untouched: they are not duplicates and they are the
 * only place the counts live. */
function useSuppressDuplicateHeading(title: string, active: boolean) {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const MARK = "data-dup-title";
    const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
    const clear = () => document.querySelectorAll(`[${MARK}]`).forEach((el) => el.removeAttribute(MARK));
    const apply = () => {
      const wide = window.matchMedia("(min-width: 900px)").matches;
      const h1 = document.querySelector("main h1") as HTMLElement | null;
      if (!active || wide || !title || !h1) { clear(); return; }
      /* ── AN ATTRIBUTE AND A CSS RULE, NOT A DOM REWRITE ────────────────────────────────────
       * The first cut wrapped the heading's text node in a hidden span. React owns that subtree
       * and reconciles it away on the next data-driven render, so the suppression came and went.
       * React does NOT strip attributes it did not set, so marking the element and letting CSS do
       * the hiding survives every re-render.
       *
       * THE RULE COLLAPSES THE HEADING'S OWN TEXT, NOT ITS CHILDREN. Field Pipeline's heading is
       *     <h1>Field Pipeline<i>Every field by stage, grouped by city and owner.</i></h1>
       * and the description must stay, so font-size goes to 0 on the h1 while the <i> keeps its
       * own absolute size. Hiding the h1 outright would take the description with it.
       *
       * THE COMPARISON IS THE HEADING'S OWN TEXT — its direct text nodes, ignoring children. */
      const ownText = [...h1.childNodes]
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent ?? "")
        .join("");
      if (norm(ownText) !== norm(title)) { clear(); return; }
      if (!h1.hasAttribute(MARK)) h1.setAttribute(MARK, "1");
    };
    apply();
    /* THE HEADING ARRIVES LATE on a page that loads its data first, so one pass is not enough. */
    const mo = new MutationObserver(apply);
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    const mq = window.matchMedia("(min-width: 900px)");
    mq.addEventListener("change", apply);
    return () => { mo.disconnect(); mq.removeEventListener("change", apply); clear(); };
  }, [title, active]);
}

export default function MobileAppBar() {
  const { nav, chrome } = useSectionNavValue();
  const pathname = usePathname() ?? "";
  const [open, setOpen] = useState(false);

  const items = useMemo(() => nav?.items ?? [], [nav]);
  const current = items.find((s) => pathname === s.href || pathname.startsWith(s.href + "/"));
  /* MORE THAN ONE SCREEN IS WHAT MAKES THE TITLE A CONTROL. */
  const hasSiblings = items.length > 1;
  const title = chrome.title ?? current?.label ?? (items.length ? nav?.label ?? "" : standaloneTitle(pathname));
  useSuppressDuplicateHeading(title, true);

  const inner = (
    <>
      {/* `leading` is a page's own status mark (Gameday's PRODUCTION dot). It sits before the
          title, which is where the pattern puts it: "● Gameday Ops ▾". */}
      {chrome.leading}
      {hasSiblings && (
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#42594e" strokeWidth={2.2} strokeLinecap="round" aria-hidden>
          <path d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      )}
      <span>{title}</span>
      {hasSiblings && <span className="text-[12px]" style={{ color: "#5c7168" }} aria-hidden>▾</span>}
    </>
  );

  return (
    <div className="min-[900px]:hidden" data-testid="mo-mobile-header" data-siblings={hasSiblings ? "1" : "0"}>
      {/* THE STICKY BAND. No vertical padding: minHeight sets the 44px, and a page whose actions
          carry a proper 44px target would otherwise be padded to 56. Three stacked bands is a
          budget, and that one spent 12px on nothing. */}
      <div
        className="sticky top-0 z-[12] flex items-center border-b px-3"
        /* minHeight INCLUDES the padding under border-box, so a bare 44px here gave a 44px TOTAL
           on a notched phone: 59px of inset and a 36px band squeezed inside it. The band under the
           inset is 44px because the inset is added to it. */
        style={{ background: "#f8faf9", borderColor: "#e6ebe8", paddingTop: "var(--sat)",
          minHeight: "calc(44px + var(--sat))" }}
      >
        {hasSiblings ? (
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-label={`${title} — change screen`}
            data-testid="mo-screen-picker"
            className="flex min-h-[36px] items-center gap-1.5 rounded-md pr-1 text-[17px] font-[760] tracking-[-0.02em]"
            style={{ color: "#12241d" }}
          >
            {inner}
          </button>
        ) : (
          /* NOT A BUTTON. There is nowhere to go. */
          <h2
            data-testid="mo-screen-title"
            className="flex min-h-[36px] items-center gap-1.5 text-[17px] font-[760] tracking-[-0.02em]"
            style={{ color: "#12241d" }}
          >
            {inner}
          </h2>
        )}
        {chrome.actions && (
          <span className="ml-auto flex items-center gap-1.5" data-testid="mo-header-actions">{chrome.actions}</span>
        )}
      </div>
      {hasSiblings && (
        <MatchOpsSectionSheet
          open={open}
          onClose={() => setOpen(false)}
          items={items}
          title={nav?.label ?? "Screens"}
          showSwitch={nav?.showSwitch ?? false}
        />
      )}
    </div>
  );
}

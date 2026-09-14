"use client";

// The Match Ops screen picker, as a bottom sheet. On a phone, Gameday Ops replaces
// the horizontal tab scroller (the since-deleted MatchOpsMobileStrip) with a title BUTTON that opens
// this — eleven destinations is a list you read, not a strip you hunt in. Self-
// contained: it owns the shared badge-count hooks and the section list, so a caller
// only toggles `open`. The current screen is marked from the pathname (aria-current).
//
// Same visual language as that strip's sheet (safe-area padding, scrim below
// the OS status band) so the two nav surfaces feel identical; this one is used by the
// Gameday board, that one by every other Match Ops route.

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/lib/useAuth";
import { useCrmAwaitingCount } from "@/lib/useCrmAwaitingCount";
import { useManagerPayAttnCount } from "@/lib/useManagerPayAttnCount";
import { usePartnerDashboardsCount } from "@/lib/usePartnerDashboardsCount";
import { visibleSections, tabForPath, type RailItem } from "./sections";
import SectionSwitch from "./SectionSwitch";

// ONE SHEET, TWO CALLERS — see ChatsRail. `items`/`title`/`showSwitch` omitted keeps the original
// Match Ops behaviour exactly; the city tier passes its three and suppresses the switch.
export default function MatchOpsSectionSheet({ open, onClose, items: itemsProp, title = "Match Ops", showSwitch = true }: { open: boolean; onClose: () => void; items?: RailItem[]; title?: string; showSwitch?: boolean }) {
  const { appUser } = useAuth();
  const pathname = usePathname() ?? "";
  const router = useRouter();
  const awaiting = useCrmAwaitingCount();
  const managerPayAttn = useManagerPayAttnCount();
  const partnerCount = usePartnerDashboardsCount();

  // Phase 24 — only the CURRENT tab's items. The tab is derived from the route; there is no
  // tab state to fall out of sync with where the operator actually is.
  const items: RailItem[] = useMemo(() => itemsProp ?? visibleSections(appUser, tabForPath(pathname)), [itemsProp, appUser, pathname]);
  const isActive = (href: string) => pathname === href || pathname.startsWith(href + "/");
  const countFor = (badge?: "awaiting" | "manager-pay" | "partner-dashboards") => {
    const n = badge === "awaiting" ? awaiting : badge === "manager-pay" ? managerPayAttn : badge === "partner-dashboards" ? partnerCount : 0;
    return n > 0 ? n : null;
  };
  const nav = (href: string) => { onClose(); if (!isActive(href)) router.push(href); };

  /* ── THERE IS NO SEARCH FIELD, AND THERE SHOULD NEVER HAVE BEEN ONE ──────────────────────────
   * It was added on the argument that "eleven is a list you hunt in". ELEVEN DOES NOT EXIST. Match
   * Ops is two tabs of 7 and 12; the rest are Finance 10, Lifecycle 8, Growth 4, City 3, Tech 3.
   * The biggest list in the app is twelve rows, and twelve rows is a thumb flick.
   *
   * It only ever looked necessary because the list was showing two of seven — the double
   * subtraction below. A layout bug made a search box feel like a design, and it is the same
   * "remember the name" problem as the field picker in a smaller costume. Ryan: "thats such a dumb
   * system i have to search tabs? I dont remember the names and its slow."
   *
   * ── THE GROUPS THE DATA ALREADY CARRIED ─────────────────────────────────────────────────────
   * RailItem.group has existed since the rail was built, the desktop rail renders it, and the
   * sheet threw it away — so eleven Match Ops destinations arrived as one flat run. Rendered in
   * FIRST-APPEARANCE ORDER, once each, so the sheet reads the same top-to-bottom as the rail. */
  const groups = useMemo(() => {
    /* KEYED BY NAME, NOT BY RUN. Rendering consecutive runs emits the SAME heading twice for a
     * section whose items are not contiguous by group, which is a list that looks duplicated
     * rather than grouped. The order is each group's FIRST appearance, so the sheet still reads
     * top-to-bottom the way the rail does. */
    const order: string[] = [];
    const byName = new Map<string, RailItem[]>();
    for (const it of items) {
      const name = it.group ?? "";
      if (!byName.has(name)) { byName.set(name, []); order.push(name); }
      byName.get(name)!.push(it);
    }
    return order.map((name) => ({ name, rows: byName.get(name)! }));
  }, [items]);
  const currentLabel = items.find((s2) => isActive(s2.href))?.label ?? null;

  /* IS THERE ANYTHING BELOW THE FOLD. Measured from the element, not guessed from a row count, so
   * it stays right whatever the rows end up being: a list that fits reports false and the fade
   * never appears. Re-measured on open, on scroll, and when the rows change. */
  const listRef = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  const measure = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    setMore(el.scrollHeight - el.clientHeight - el.scrollTop > 2);
  }, []);
  const onListScroll = measure;
  useEffect(() => {
    if (!open) { setMore(false); return; }
    /* AFTER PAINT: on the frame the sheet opens the list has no height yet, so measuring inline
     * reports "nothing below" for every list. */
    const id = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(id);
  }, [open, items, measure]);



  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex flex-col justify-end" role="dialog" aria-modal="true" aria-label={`Go to ${title} screen`} data-testid="screen-sheet">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-x-0 bottom-0" style={{ top: "var(--sat)", background: "rgba(6,26,18,.42)" }} />
      {/* THE SHEET MUST CLEAR THE FIXED BOTTOM NAV, and it did not.
        *
        * MEASURED at 390x844: the panel ran to y=844 (the viewport floor) while the bottom nav
        * starts at y=787, so the last row — Player Chats — rendered at y=830, BEHIND the nav.
        * And it could not be scrolled to, because there was nothing to scroll: scrollHeight and
        * clientHeight were both 515. The list fitted its own max-height perfectly and was simply
        * occluded, which is why it reads as "it doesn't let me scroll" rather than as a clipped row.
        *
        * --bottom-nav-h already exists for exactly this (globals.css:137, 0 on desktop). Adding it
        * to the padding pushes the last row clear; subtracting it from the max-height means a
        * longer list becomes genuinely scrollable instead of growing under the nav. */}
      {/* ── A FIXED, GENEROUS HEIGHT ────────────────────────────────────────────────────────────
        * It used to be max-height only, so Growth's four rows made it hug them and it opened as a
        * small tray near the thumb: a popup menu, not a place you navigate from. A surface that
        * changes size with its contents reads as a tooltip; one that does not reads as a place.
        * HEIGHT, not max-height, so Growth (four screens) and Match Ops (eleven) open identically.
        *
        * ── THE NAV IS CLEARED ONCE, BY THE HEIGHT ──────────────────────────────────────────
        * It used to be cleared twice. The height subtracted --bottom-nav-h AND the paddingBottom
        * added it again, which on an 844px phone left a 620-76=544 panel with 124px of padding:
        * about 259px of list, which is TWO ROWS of Daily Ops' seven. The header said "7 screens"
        * and the list showed two.
        *
        * The pairing was right in the old component, where maxHeight let the panel grow to the
        * floor and the padding is what pushed the last row clear. With a fixed height that already
        * subtracts the nav it is double-counting: one was moved and the other was not re-checked.
        *
        * 90vh capped at 760 is what Daily Ops' SEVEN rows need without scrolling, measured rather
        * than guessed, and it is still not a full-screen takeover on a tablet. */}
      <div className="relative flex flex-col overscroll-contain rounded-t-[22px]"
        style={{ background: "#ffffff",
          boxShadow: "0 -2px 8px rgba(7,42,32,.06), 0 -26px 60px -20px rgba(7,42,32,.42)",
          height: "calc(min(90%, 760px) - var(--bottom-nav-h))",
          paddingBottom: "calc(14px + var(--sab))" }}>
        <div className="flex justify-center pb-1 pt-2"><span className="h-[5px] w-[38px] rounded-full" style={{ background: "#dbe3df" }} /></div>
        {/* ── A HEADER THAT SAYS WHERE YOU ARE ──────────────────────────────────────────────── */}
        <div className="flex flex-none items-start gap-2.5 px-[18px] pb-2 pt-1.5">
          <div className="min-w-0 flex-1">
            <h2 className="text-[20px] font-[780] tracking-[-0.024em]" style={{ color: "#12241d" }} data-testid="sheet-title">{title}</h2>
            <p className="mt-0.5 text-[12.5px] font-[540]" style={{ color: "#6d7b74" }} data-testid="sheet-sub">
              {items.length} screen{items.length === 1 ? "" : "s"}
              {currentLabel ? ` · you are on ${currentLabel}` : ""}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" data-testid="sheet-close"
            className="flex h-10 w-10 flex-none items-center justify-center rounded-full" style={{ color: "#42594e" }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.1} strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>
        {/* ── THE TIER SWITCH IS CHROME, NOT A ROW ────────────────────────────────────────────
          * It used to scroll inside the list, which cost the list about 84px — the difference
          * between six of Daily Ops' seven screens and all seven — and meant the Daily Ops / Back
          * Office tabs could scroll off the top of the thing they switch. */}
        {showSwitch && <div className="flex-none px-2.5 pb-1"><SectionSwitch /></div>}

        {/* ── WHEN A LIST DOES SCROLL, IT HAS TO LOOK LIKE IT SCROLLS ─────────────────────────
          * Back Office has twelve and still scrolls. A sheet that ends in flat white reads as
          * finished, which is exactly how two rows out of seven read as "that is all there is".
          * The fade is on only while there is something below and off at the end, so it is a
          * statement about the list rather than decoration. It is the one thing that would have
          * made the double-subtraction visible instead of merely confusing. */}
        <div className="relative min-h-0 flex-1">
          {/* THE LIST IS THE ONLY THING THAT SCROLLS, so the header and the footer line stay put. */}
          <div ref={listRef} onScroll={onListScroll}
            className="h-full overflow-y-auto overscroll-contain px-2.5" data-testid="sheet-list">
            {groups.map((g) => (
            <div key={g.name || "_"}>
              {g.name && (
                <p data-testid="sheet-group" className="px-3 pb-1 pt-3 text-[10.5px] font-[800] uppercase tracking-[0.09em]"
                  style={{ color: "#9aa8a1" }}>{g.name}</p>
              )}
              {g.rows.map((s) => {
            const on = isActive(s.href);
            const n = countFor(s.badge);
            return (
              <button
                key={s.href}
                type="button"
                onClick={() => nav(s.href)}
                data-testid={`screen-dest-${s.key}`}
                aria-current={on ? "page" : undefined}
                className="flex min-h-[56px] w-full items-center gap-3 rounded-[14px] px-3 py-[11px] text-left"
                style={on ? { background: "#e0f2e7" } : undefined}
              >
                <span className="flex h-9 w-9 flex-none items-center justify-center rounded-[12px] border [&_svg]:h-[18px] [&_svg]:w-[18px]" style={on ? { background: "#fff", borderColor: "#c9e8d8", color: "#12704a" } : { background: "#eef3f0", borderColor: "#e2eae5", color: "#4d6359" }}>
                  {s.icon}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15.5px] font-[650] tracking-[-0.012em]" style={{ color: on ? "#0f3d2e" : "#12241d", fontWeight: on ? 760 : 650 }}>{s.label}</span>
                  <span className="block truncate text-[12.5px] font-[540]" style={{ color: "#6d7b74" }}>{s.desc}</span>
                </span>
                {n != null && (
                  <span className="flex-none rounded-full px-[9px] py-0.5 text-[12.5px] font-[730]" style={on ? { background: "#fff", color: "#12704a" } : { background: "rgba(0,0,0,.05)", color: "#8d9c94" }}>{n}</span>
                )}
                {on && (
                  <svg viewBox="0 0 24 24" className="h-5 w-5 flex-none" fill="none" stroke="#12764c" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 12.5l4.5 4.5L19 7" /></svg>
                )}
              </button>
            );
          })}
              </div>
            ))}
          </div>
          <span
            aria-hidden
            data-testid="sheet-fade"
            data-on={more ? "1" : "0"}
            className="pointer-events-none absolute inset-x-0 bottom-0 transition-opacity"
            style={{ height: 26, opacity: more ? 1 : 0,
              background: "linear-gradient(to bottom, rgba(255,255,255,0), #ffffff)" }}
          />
        </div>
        {/* ── THE LINE THAT DRAWS THE BOUNDARY BETWEEN THE TWO NAVS ───────────────────────────
          * The bottom bar carries the SECTIONS; this sheet carries the SCREENS inside one of them.
          * That division is correct and is what every phone app does, but nothing on screen said
          * so, which is how a list of four reads as "is this all there is?". */}
        <p className="flex-none px-[18px] pt-2.5 text-[11.5px] font-[540] leading-[1.45]"
          data-testid="sheet-foot" style={{ color: "#8d9c94" }}>
          Sections live in the bar at the bottom. This list is the screens inside {title}.
        </p>
      </div>
    </div>
  );
}

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
import { useEffect, useMemo, useState } from "react";
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

  /* ── A SEARCH FIELD, BUT ONLY WHEN THERE IS SOMETHING TO SEARCH ──────────────────────────────
   * Four screens is a list you read; eleven is a list you hunt in. An empty search box over four
   * items is furniture, so the threshold is six. */
  const [q, setQ] = useState("");
  const searchable = items.length >= 6;
  const query = searchable ? q.trim().toLowerCase() : "";
  const shown = useMemo(
    () => (!query ? items : items.filter((s2) =>
      [s2.label, s2.desc, s2.group].filter(Boolean).some((f) => String(f).toLowerCase().includes(query)))),
    [items, query],
  );
  /* ── THE GROUPS THE DATA ALREADY CARRIED ─────────────────────────────────────────────────────
   * RailItem.group has existed since the rail was built, the desktop rail renders it, and the
   * sheet threw it away — so eleven Match Ops destinations arrived as one flat run. Rendered in
   * FIRST-APPEARANCE ORDER, once each, so the sheet reads the same top-to-bottom as the rail. */
  const groups = useMemo(() => {
    const out: { name: string; rows: RailItem[] }[] = [];
    for (const it of shown) {
      const name = it.group ?? "";
      const last = out[out.length - 1];
      if (last && last.name === name) last.rows.push(it);
      else out.push({ name, rows: [it] });
    }
    return out;
  }, [shown]);
  const currentLabel = items.find((s2) => isActive(s2.href))?.label ?? null;

  /* The box is reset whenever the sheet is opened, so it never reopens mid-filter. */
  useEffect(() => { if (!open) setQ(""); }, [open]);

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
        * --bottom-nav-h is subtracted for the reason below; 78vh capped at 620 keeps it generous
        * on a small phone and stops it becoming a full-screen takeover on a tablet. */}
      <div className="relative flex flex-col overscroll-contain rounded-t-[22px]"
        style={{ background: "#ffffff",
          boxShadow: "0 -2px 8px rgba(7,42,32,.06), 0 -26px 60px -20px rgba(7,42,32,.42)",
          height: "calc(min(78%, 620px) - var(--bottom-nav-h))",
          paddingBottom: "calc(14px + var(--sab) + var(--bottom-nav-h))" }}>
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
        {searchable && (
          <div className="flex-none px-[18px] pb-2">
            <input
              data-testid="sheet-search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={`Find a screen in ${title}`}
              aria-label={`Find a screen in ${title}`}
              className="w-full rounded-[11px] border px-3 text-[14px]"
              style={{ minHeight: 44, borderColor: "#dfe7e3", background: "#f7faf8", color: "#12241d" }}
            />
          </div>
        )}
        {/* THE LIST IS THE ONLY THING THAT SCROLLS, so the header and the footer line stay put. */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2.5" data-testid="sheet-list">
          {showSwitch && <SectionSwitch />}
          {query && shown.length === 0 && (
            <p className="px-3 py-6 text-center text-[13px]" data-testid="sheet-none" style={{ color: "#8d9c94" }}>
              No screen in {title} matches &ldquo;{q.trim()}&rdquo;.
            </p>
          )}
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

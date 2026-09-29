"use client";

/* THE PLAYER ACTIVITY ASSUMPTIONS, behind the "i" beside the page title.
 *
 * Hover, tap or keyboard focus shows them; nothing is printed on the page.
 *
 * ── EVERY LINE WAS CHECKED AGAINST THE CODE, AND TWO WERE REWRITTEN ──────────────────────────
 * The brief's wording was checked line by line against src/app/api/lifecycle/behavior-weekly/route.ts
 * and supabase/migrations/0096 + 0157. Where the code differs, THE WORDING MOVED, not the code:
 *
 *   1. "Excludes deleted accounts, test players and cancelled matches."
 *      CHANGED. There is no deleted-account filter and there is no column to build one from —
 *      mdapi_users (migration 0020) has no `deleted_at`, and the route filters only
 *      `is_fake_player` and "signup completed". Deleted MATCHES and deleted ROSTER ROWS are
 *      excluded (`.is("deleted_at", null)` on both), and cancelled matches and player-cancelled
 *      roster rows are excluded too. Claiming an account filter that does not exist is exactly the
 *      kind of line someone would later rely on.
 *
 *   4. "Months and days follow Central time."
 *      CHANGED. It is true of REGISTRATIONS and false of MATCHES, and the difference is deliberate
 *      and load-bearing. `completed_sign_up_at` is a true UTC instant and is converted to its
 *      America/Chicago day (route, chicagoYmd; migration 0157 for the monthly view). `start_date`
 *      is LOCAL WALL CLOCK wearing a Z it does not mean, and is SLICED, never converted — 0096
 *      renders it `AT TIME ZONE 'UTC'` for exactly that reason. So a match falls on the day it was
 *      played at the pitch, in the pitch's own local time, which for Warsaw is not Central.
 *
 * The other three were verified and are unchanged: city/field attribution (matchCity and matchField
 * come from the MATCH, registrations from `preferable_city_name`), the per-city double count (each
 * city keeps its own Set, so a player in two cities is in both), and Warsaw being counted in
 * Overall (normalizeMatchCity maps WAW, and Overall counts every match whatever its city).
 */

import { useCallback, useEffect, useState } from "react";
import styles from "./playerActivity.module.css";

const LINES = [
  "Excludes test players, cancelled matches, and deleted match and roster records. Deleted accounts are not excluded: the players table carries no deleted flag.",
  "Players and spots count in the city and field where the match was played. Registrations count in the city selected at signup.",
  "A player who plays in two cities counts in each, so city rows can add up to more than the total.",
  "Registration days follow Central time. Match days follow the pitch's own local clock. The current month is partial.",
  "Warsaw, a licensed operator, is included in Overall.",
];

export default function AssumptionsInfo() {
  const [open, setOpen] = useState<{ x: number; y: number } | null>(null);
  const show = useCallback((el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setOpen({ x: r.left + r.width / 2, y: r.bottom + 8 });
  }, []);
  const hide = useCallback(() => setOpen(null), []);
  useEffect(() => {
    if (!open) return;
    const onScroll = () => setOpen(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(null); };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("scroll", onScroll, true); window.removeEventListener("keydown", onKey); };
  }, [open]);

  return (
    <>
      <span
        className={styles.info} tabIndex={0} role="button"
        data-testid="pa-assumptions" aria-label="What this page assumes"
        onMouseEnter={(e) => show(e.currentTarget)}
        onMouseLeave={hide}
        onFocus={(e) => show(e.currentTarget)}
        onBlur={hide}
        onClick={(e) => { e.stopPropagation(); open ? hide() : show(e.currentTarget); }}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open ? hide() : show(e.currentTarget); } }}
      >i</span>
      {open && (
        <div className={styles.tip} role="tooltip" data-testid="pa-assumptions-tip"
          style={{ left: open.x, top: open.y, maxWidth: 340 }}>
          <ul className={styles.tipList}>
            {LINES.map((l) => <li key={l}>{l}</li>)}
          </ul>
        </div>
      )}
    </>
  );
}

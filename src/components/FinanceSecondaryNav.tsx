"use client";

import { Fragment } from "react";

// Secondary nav for /admin/finance — ONE muted text link, riding in the period bar.
//
// WAS THREE. "Managers" only ever redirected to /match-ops/manager-pay, which has its own rail
// entry — a second door to the same room. "City Manager Check-Ins" moved to Match Ops › Back
// Office › People, where the other people-shaped pages live, and became a real page instead of an
// overlay. Configure is the only one left that is genuinely a Finance-wide affordance.
//
// (original note) Secondary nav for /admin/finance — three muted text links above the
// hero, aligned right. Visually quieter than the green pill row so
// it reads as "secondary" at a glance. Items map to non-pill views:
//   - configure        → expands a sub-strip (Revenue, Expenses,
//                         Manager Pay, Field Costs, Billing Schedule,
//                         Change Log)
//   - check-ins        → standalone view (was "Check-Ins" pill)
//   - partner-dashboards → standalone view
//
// `active` is null when no secondary item is selected (the user is
// on a primary pill instead).

export type SecondaryId = "configure";

// Partner Dashboards moved to Match Ops (2026-08); Managers is a convenience
// jump to its Match Ops home.
const ITEMS: { id: SecondaryId; label: string }[] = [
  { id: "configure", label: "Configure" },
];

export default function FinanceSecondaryNav({
  active,
  onChange,
  // INLINE drops the strip's own margin and right-alignment: the links now ride inside the period
  // bar, which already handles that placement. Same buttons, same behaviour, one less row.
  inline = false,
}: {
  active: SecondaryId | null;
  onChange: (id: SecondaryId) => void;
  inline?: boolean;
}) {
  return (
    <nav
      aria-label="Finance secondary views"
      className={inline ? "flex" : "mb-3 flex justify-end"}
    >
      <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.12em]">
        {ITEMS.map((item, i) => {
          const isActive = active === item.id;
          return (
            <Fragment key={item.id}>
              {i > 0 && <span className="text-deep-green/30">·</span>}
              <button
                type="button"
                onClick={() => onChange(item.id)}
                className={`inline-flex min-h-[44px] items-center transition ${
                  isActive
                    ? "text-deep-green underline underline-offset-4"
                    : "text-deep-green/55 hover:text-deep-green hover:underline hover:underline-offset-4"
                }`}
              >
                {item.label}
              </button>
            </Fragment>
          );
        })}
      </div>
    </nav>
  );
}

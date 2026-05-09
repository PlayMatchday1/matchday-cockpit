"use client";

import { Fragment } from "react";

// Secondary nav for /admin/finance — three muted text links above the
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

export type SecondaryId =
  | "configure"
  | "check-ins"
  | "partner-dashboards"
  | "match-manager-pay";

const ITEMS: { id: SecondaryId; label: string }[] = [
  { id: "configure", label: "Configure" },
  { id: "check-ins", label: "City Manager Check-Ins" },
  { id: "match-manager-pay", label: "Match Manager Pay" },
  { id: "partner-dashboards", label: "Partner Dashboards" },
];

export default function FinanceSecondaryNav({
  active,
  onChange,
}: {
  active: SecondaryId | null;
  onChange: (id: SecondaryId) => void;
}) {
  return (
    <nav
      aria-label="Finance secondary views"
      className="mb-3 flex justify-end"
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
                className={`transition ${
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

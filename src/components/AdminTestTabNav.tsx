"use client";

// Sub-tab pill nav for /admin/test. Pattern copied from FinanceTabNav (NOT a
// modification of it) so the shared Finance nav is untouched. Controlled —
// parent owns the active-tab state; a click dispatches via onChange.

export const ADMIN_TEST_TAB_IDS = [
  "revenue",
  "field-costs",
  "growth",
  "members-retention",
  "v8-mockup",
] as const;

export type AdminTestTabId = (typeof ADMIN_TEST_TAB_IDS)[number];

const TABS: { id: AdminTestTabId; label: string }[] = [
  { id: "revenue", label: "Revenue" },
  { id: "field-costs", label: "Field Costs" },
  { id: "growth", label: "Growth" },
  { id: "members-retention", label: "Members & Retention" },
  { id: "v8-mockup", label: "v8 mockup" },
];

export default function AdminTestTabNav({
  value,
  onChange,
}: {
  value: AdminTestTabId;
  onChange: (next: AdminTestTabId) => void;
}) {
  return (
    <nav
      aria-label="Analytics test views"
      className="sticky top-0 z-30 -mx-4 mb-8 border-y border-cream-line bg-cream-soft/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-cream-soft/80 sm:-mx-6 sm:px-6"
    >
      <div role="tablist" className="flex flex-wrap items-center gap-2">
        {TABS.map((t) => {
          const active = t.id === value;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onChange(t.id)}
              className={
                active
                  ? "rounded-full bg-mint px-4 py-1.5 text-xs font-bold text-deep-green transition hover:bg-mint-hover"
                  : "rounded-full border border-cream-line bg-white px-3 py-1.5 text-xs font-bold text-deep-green transition hover:bg-cream-soft"
              }
            >
              {t.label}
            </button>
          );
        })}
      </div>
    </nav>
  );
}

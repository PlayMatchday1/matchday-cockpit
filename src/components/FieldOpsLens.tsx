"use client";

// Field Ops top-tab content, now split into two inner tabs:
//   • Fields    — the venue roster (CitiesFieldsLens, existing)
//   • Inventory — the equipment dashboard (InventoryDashboard, new)
// Inner-tab state is local (defaults to Fields); the top-level Cities tab
// stays URL-backed as before.

import { useState } from "react";
import CitiesFieldsLens from "@/components/CitiesFieldsLens";
import InventoryDashboard from "@/components/InventoryDashboard";

type Inner = "fields" | "inventory";

const TABS: { key: Inner; label: string }[] = [
  { key: "fields", label: "Fields" },
  { key: "inventory", label: "Inventory" },
];

export default function FieldOpsLens() {
  const [inner, setInner] = useState<Inner>("fields");

  return (
    <div>
      <div className="mb-6 flex gap-6 border-b border-cream-line">
        {TABS.map((t) => {
          const active = inner === t.key;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setInner(t.key)}
              aria-pressed={active}
              className={`-mb-px border-b-2 pb-3 text-sm font-bold transition ${
                active
                  ? "border-mint text-deep-green"
                  : "border-transparent text-deep-green/45 hover:text-deep-green/70"
              }`}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {inner === "fields" ? <CitiesFieldsLens /> : <InventoryDashboard />}
    </div>
  );
}

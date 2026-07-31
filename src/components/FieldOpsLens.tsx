"use client";

// Field Ops top-tab content, split into inner tabs:
//   • Fields    — the venue roster (CitiesFieldsLens)
//   • Inventory — the equipment dashboard (InventoryDashboard)
//   • Veo       — the Veo review queue + field-code editor (VeoDashboard),
//                 relocated here from /admin/veo. Admin-only: its data
//                 endpoints require is_admin, so the tab shows for admins only.
// Inner-tab state is URL-backed via ?fo= (same URL-as-source-of-truth approach
// as the top-level Cities ?tab=), so a tab is deep-linkable and survives a
// refresh. The default (fields) carries no param.

import { useCallback, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import CitiesFieldsLens from "@/components/CitiesFieldsLens";
import InventoryDashboard from "@/components/InventoryDashboard";
import VeoDashboard from "@/components/VeoDashboard";
import CommunityDashboard from "@/components/CommunityDashboard";
import { useAuth } from "@/lib/useAuth";

type Inner = "fields" | "inventory" | "veo" | "community";

const BASE_TABS: { key: Inner; label: string }[] = [
  { key: "fields", label: "Fields" },
  { key: "inventory", label: "Inventory" },
];

export default function FieldOpsLens() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { appUser } = useAuth();
  const isAdmin = appUser?.is_admin === true;

  const tabs = useMemo(
    () =>
      isAdmin
        ? [
            ...BASE_TABS,
            { key: "veo" as Inner, label: "Veo" },
            { key: "community" as Inner, label: "Community" },
          ]
        : BASE_TABS,
    [isAdmin],
  );

  const inner: Inner = useMemo(() => {
    const raw = searchParams.get("fo");
    if (raw === "inventory") return "inventory";
    if (raw === "veo" && isAdmin) return "veo";
    if (raw === "community" && isAdmin) return "community";
    return "fields";
  }, [searchParams, isAdmin]);

  const setInner = useCallback(
    (key: Inner) => {
      // Preserve the top-level tab (tab=fields) and toggle only ?fo=. Default
      // (fields) drops the param so the URL stays clean.
      const params = new URLSearchParams(searchParams.toString());
      if (key === "fields") params.delete("fo");
      else params.set("fo", key);
      const qs = params.toString();
      router.replace(qs ? `/growth?${qs}` : "/growth", { scroll: false });
    },
    [router, searchParams],
  );

  return (
    <div>
      <div className="mb-6 flex gap-6 border-b border-cream-line">
        {tabs.map((t) => {
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

      {inner === "fields" && <CitiesFieldsLens />}
      {inner === "inventory" && <InventoryDashboard />}
      {inner === "veo" && isAdmin && <VeoDashboard />}
      {inner === "community" && isAdmin && <CommunityDashboard />}
    </div>
  );
}

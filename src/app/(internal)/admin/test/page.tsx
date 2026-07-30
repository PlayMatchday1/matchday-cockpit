"use client";

// /admin/test — staging ground for the v8 analytics dashboard. Admin-only.
//
// Four analytics sub-tabs (Revenue, Field Costs, Growth, Members & Retention)
// are intentionally EMPTY placeholders: the revenue-basis and registrations
// definitions are still open, so nothing is built here yet. The fifth sub-tab
// renders the design mockup in an <iframe> so we can flip between a built page
// and the design in the same tab.
//
// Gated on app_users.is_admin directly (canAccess short-circuits on is_admin;
// there's no "test" PageName and adding one would edit shared useAuth). Touches
// nothing outside /admin/test, its nav component, and public/mockups/.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth, firstAllowedPath } from "@/lib/useAuth";
import AdminTestTabNav, { type AdminTestTabId } from "@/components/AdminTestTabNav";

const MOCKUP_SRC = "/mockups/clubhouse-additions-v8.html";

const PLACEHOLDERS: Record<
  Exclude<AdminTestTabId, "v8-mockup">,
  { title: string }
> = {
  revenue: { title: "Revenue" },
  "field-costs": { title: "Field Costs" },
  growth: { title: "Growth" },
  "members-retention": { title: "Members & Retention" },
};

export default function AdminTestPage() {
  const { appUser, isLoading } = useAuth();
  const router = useRouter();
  const [tab, setTab] = useState<AdminTestTabId>("revenue");

  // is_admin gate — mirrors PagePermissionGuard's redirect, but keyed on
  // is_admin only (stricter than a page permission).
  useEffect(() => {
    if (isLoading || !appUser) return;
    if (!appUser.is_admin) router.replace(firstAllowedPath(appUser));
  }, [appUser, isLoading, router]);

  if (isLoading || !appUser) return null;
  if (!appUser.is_admin) return null;

  return (
    <div className="mx-auto max-w-[1640px] px-4 py-8 sm:px-6">
      <div className="mb-2">
        <h1 className="text-2xl font-bold tracking-tight text-deep-green">
          Analytics (test)
        </h1>
        <p className="mt-1 text-sm text-deep-green/60">
          Staging for the v8 operating dashboard. The four analytics tabs are
          not built yet; the design lives under “v8 mockup”.
        </p>
      </div>

      <AdminTestTabNav value={tab} onChange={setTab} />

      {tab === "v8-mockup" ? (
        <div>
          {/* Non-dismissible, always-visible sample-data banner. */}
          <div
            role="alert"
            className="mb-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm font-bold text-amber-800"
          >
            Design mockup — all figures are sample data, not live. For layout
            review only.
          </div>
          {/* MUST stay an iframe: the mockup ships global element selectors
              (star, html, body) that would overwrite Cockpit's layout if
              inlined. */}
          <iframe
            src={MOCKUP_SRC}
            title="Matchday Clubhouse — Operating Dashboard v8 (design mockup)"
            className="w-full rounded-xl border border-cream-line bg-white"
            style={{ height: "calc(100vh - 220px)", minHeight: 640 }}
          />
        </div>
      ) : (
        <div className="rounded-2xl border-[1.5px] border-dashed border-cream-line bg-white p-10 text-center shadow-sm">
          <h2 className="text-lg font-bold text-deep-green">
            {PLACEHOLDERS[tab].title}
          </h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-deep-green/55">
            Not built yet. Blocked on the open revenue-basis and
            registrations-definition decisions; nothing is guessed here.
          </p>
        </div>
      )}
    </div>
  );
}

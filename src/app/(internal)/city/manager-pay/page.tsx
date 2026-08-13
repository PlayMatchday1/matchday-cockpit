// Phase 25 Part B — the city manager's only page.
//
// It lives OUTSIDE /match-ops on purpose: that layout mounts the 14-item operator rail and the CRM
// dock, neither of which a city manager may reach. This route group has no rail at all — one
// account, one page.
//
// Client-side gating here is COURTESY ONLY (a bounce beats a 403 wall). The real gate is
// authenticateCityManager on /api/manager-pay/city-week, which is where the city scope is enforced
// on both the read and the write.

"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth, isCityManager, firstAllowedPath } from "@/lib/useAuth";
import CityManagerPayClient from "./CityManagerPayClient";

export default function CityManagerPayPage() {
  const { appUser, isLoading } = useAuth();
  const router = useRouter();

  // Admins are allowed to look (they can already see every city on the admin Manager Pay page, so
  // this is not a widening); anyone else without the tier is sent to wherever they do belong.
  const allowed = isCityManager(appUser) || !!appUser?.is_admin;

  useEffect(() => {
    if (isLoading || !appUser) return;
    if (!allowed) router.replace(firstAllowedPath(appUser));
  }, [allowed, appUser, isLoading, router]);

  if (isLoading || !appUser) return <div className="p-8 text-sm text-[#6d7b74]">Loading…</div>;
  if (!allowed) return null;
  return <CityManagerPayClient />;
}

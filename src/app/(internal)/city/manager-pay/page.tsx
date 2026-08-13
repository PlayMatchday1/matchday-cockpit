// Phase 25 Part B — the city manager's only page.
//
// It lives OUTSIDE /match-ops on purpose: that layout mounts the 14-item operator rail and the CRM
// dock, neither of which a city manager may reach. This route group has no rail at all — one
// account, one page.
//
// Client-side gating here is COURTESY ONLY (a bounce beats a 403 wall). The real gate is
// authenticateCityManager on /api/manager-pay/city-week, which is where the city scope is enforced
// on both the read and the write.
//
// ADMINS ARE BOUNCED, not admitted. Letting an admin render this page while the route it calls
// refuses them is a control that looks live and does nothing — the exact thing we do not ship. The
// inconsistency is closed by narrowing the PAGE, never by adding an "or admin" branch to the gate:
// that branch would have to be carried by every future assertion about the tier. Admins already
// have /match-ops/manager-pay, which covers every city; a second pay screen is the fragmentation
// this week was spent removing.

"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth, isCityManager, firstAllowedPath } from "@/lib/useAuth";
import CityManagerPayClient from "./CityManagerPayClient";

// The admin equivalent: every city, with a city filter.
const ADMIN_MANAGER_PAY = "/match-ops/manager-pay";

export default function CityManagerPayPage() {
  const { appUser, isLoading } = useAuth();
  const router = useRouter();

  // ONE meaning: this page is the city-manager tier's page. Nothing else opens it.
  const allowed = isCityManager(appUser);
  const isAdmin = !!appUser?.is_admin && !allowed;

  useEffect(() => {
    if (isLoading || !appUser) return;
    if (allowed) return;
    // An admin goes to their own pay screen, not to a generic landing — it is the same job.
    router.replace(isAdmin ? ADMIN_MANAGER_PAY : firstAllowedPath(appUser));
  }, [allowed, isAdmin, appUser, isLoading, router]);

  if (isLoading || !appUser) return <div className="p-8 text-sm text-[#6d7b74]">Loading…</div>;
  if (!allowed) {
    return isAdmin ? (
      <div data-testid="admin-bounce" className="p-8 text-sm text-[#6d7b74]">
        Taking you to Manager Pay — that page covers every city.
      </div>
    ) : null;
  }
  return <CityManagerPayClient />;
}

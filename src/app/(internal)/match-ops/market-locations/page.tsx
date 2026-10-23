"use client";

// Match Ops → Locations: the Locations board for ONE MARKET (Poland, for the WAW-confined accounts).
// The same LocationsBoard as /growth/locations, pointed at the scoped routes
// (/api/matchops/market-locations*), which take the market from the SESSION and filter in SQL.
// The market chosen here is a courtesy for labels and units only — the server decides what is sent.
//
// Who sees it: the rail shows it to a confined account whose city has a scope (sections.tsx,
// scopedOnly). An unconfined ADMIN who opens the URL gets Poland (marketLocationsAuth.ts); anyone
// else gets the route's refusal, shown on the page.
//
// Suspense because LocationsBoard reads the tab from the URL (useSearchParams).

import { Suspense } from "react";
import PagePermissionGuard from "@/components/PagePermissionGuard";
import LocationsBoard, { type LocationsMarket } from "@/components/LocationsBoard";
import { useAuth } from "@/lib/useAuth";
import { confinedCity, isConfined } from "@/lib/cityConfinement";
import { locationScopeForCity, POLAND } from "@/lib/locationScopes";

export default function MarketLocationsPage() {
  const { appUser } = useAuth();
  const scope = isConfined(appUser ?? undefined) ? locationScopeForCity(confinedCity(appUser ?? undefined)) : POLAND;
  const market: LocationsMarket | null = scope ? {
    apiBase: "/api/matchops/market-locations", name: scope.name, cityName: scope.cityName,
    unit: scope.unit, home: scope.center, coverageRadiusMiles: scope.coverageRadiusMiles,
  } : null;
  return (
    <PagePermissionGuard page="matchops">
      {market ? (
        <Suspense fallback={<div className="p-8 text-sm text-[#6d7b74]">Loading locations…</div>}>
          <LocationsBoard market={market} />
        </Suspense>
      ) : (
        <div className="p-8 text-sm text-[#6d7b74]">No Locations market is set up for this account.</div>
      )}
    </PagePermissionGuard>
  );
}

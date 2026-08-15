"use client";

// Reviews for a CITY MANAGER — the REAL Reviews page, scoped.
//
// WHAT THIS REPLACED. A bespoke rebuild: four hand-rolled metric boxes and a flat table. It was
// not the Reviews page with less data in it, it was a different, worse page that happened to be
// about reviews — no trailing-8-weeks strip, no managers leaderboard, no Needs attention, no
// Standouts, no month/venue/manager filters. The tier does not get a lesser product; it gets the
// same product scoped to one city.
//
// THE DIFFERENCE IS THE DATA, NOT THE UI. /api/reviews decides scope from the caller's session —
// one city for a city manager, everything for an admin — so ReviewsClient receives one city's rows
// and derives every number from them exactly as it does for an admin. `lockedCity` only locks the
// city control; it is not what makes the page safe.
//
// NO EXPLANATORY LINE. The old page carried "Scoped on the server to your city — this page never
// receives another city's reviews". The city is in the heading and in the locked control; the rest
// was the app explaining itself to someone who works here every day.

import { useAuth, isCityManager } from "@/lib/useAuth";
import { cityNameFor } from "@/lib/cityScope";
import ReviewsClient from "@/app/(internal)/match-ops/reviews/ReviewsClient";

export default function CityReviewsPage() {
  const { appUser, isLoading } = useAuth();

  if (isLoading) return <div className="p-6 text-sm text-deep-green/50">Loading…</div>;
  if (!isCityManager(appUser) && !appUser?.is_admin) {
    return <div className="p-6 text-sm text-coral" data-testid="cr-denied">Reviews requires Admin or the City Manager tier.</div>;
  }

  // The API's scope is the authority; this is the label for it. An admin opening the route sees
  // the unlocked page, which is what they get at /match-ops/reviews too.
  const lockedCity = isCityManager(appUser) && !appUser?.is_admin
    ? cityNameFor(appUser?.city_identifier) ?? appUser?.city_identifier ?? null
    : null;

  return (
    <div data-testid="city-reviews" data-scope={lockedCity ?? ""}>
      <ReviewsClient lockedCity={lockedCity} />
    </div>
  );
}

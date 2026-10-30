"use client";

// GROWTH › OFFERS. Local backend only for now, and only for the people on OFFERS_ALLOWLIST; anyone
// else sees a 404 here and every /api/offers/* route refuses them at the server.

import OffersView from "@/components/offers/OffersView";

export default function OffersPage() {
  return <OffersView />;
}

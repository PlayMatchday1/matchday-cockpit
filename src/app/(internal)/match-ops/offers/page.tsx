"use client";

// MATCH OPS › OFFERS. Where it talks to comes from OFFERS_ENV (src/lib/offersConfig.ts), and only for people with Match Ops access; anyone
// else sees a 404 here and every /api/offers/* route refuses them at the server.

import OffersView from "@/components/offers/OffersView";

export default function OffersPage() {
  return <OffersView />;
}

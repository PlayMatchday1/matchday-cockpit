"use client";

// MATCH OPS › PUSH NOTIFICATIONS. The same access as Offers (Match Ops, decided on the server by offersGate) and
// the same backend (OFFERS_ENV). Anyone else sees a 404 here, and every /api/pushes/* route refuses them.

import PushesView from "@/components/pushes/PushesView";

export default function PushNotificationsPage() {
  return <PushesView />;
}

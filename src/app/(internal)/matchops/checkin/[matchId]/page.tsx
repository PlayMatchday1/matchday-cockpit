// Phase 26 — Manager Check-In, behind a NORMAL Clubhouse login.
//
// NO TOKEN, NO MAGIC LINK, NO PUBLIC ROUTE. A link that grants roster write access has to expire
// and be scoped to one match; that is deliberately a separate conversation and is not built here.
// The route sits outside /match-ops so it does not inherit the operator rail and the CRM dock —
// this is a phone screen used at a touchline, not a console.

import CheckinClient from "./CheckinClient";

export default async function CheckinPage({ params }: { params: Promise<{ matchId: string }> }) {
  const { matchId } = await params;
  return <CheckinClient matchId={matchId} />;
}

// Player Lookup (Phase 18) — one player: account, membership, matches, with Add /
// Remove under EDIT MATCHES. Reads via /api/lookup/{env}; writes reuse the guarded
// roster route. Strikes / Payments / Account-history panels are deliberately not built.
import PlayerLookup from "@/components/PlayerLookup";

export default function PlayerLookupPage() {
  return <PlayerLookup />;
}

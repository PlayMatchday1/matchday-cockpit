// THE GATE FOR THE SCOPED LOCATIONS TAB (/api/matchops/market-locations*) — SERVER-ONLY.
//
// Match Ops' capability, then the SCOPE FROM THE SESSION, never from the request: a confined account
// gets its own city's scope (WAW → Poland, locationScopes.ts) and nothing else, and a request cannot
// name another. A confined account whose city has no scope is refused, as is one confined to a value
// the allowlist does not resolve (isConfined true, confinedCity null). An UNCONFINED account is
// served Poland only if it is an admin, so staff can see what the operator sees; anyone else is
// refused rather than handed an arbitrary market.

import "server-only";
import { authenticateCapability, type CapAuthResult } from "./capabilityAuth";
import { isConfined } from "./cityConfinement";
import { locationScopeForCity, POLAND, type LocationScope } from "./locationScopes";

export async function authenticateMarketLocations(req: Request): Promise<
  (Extract<CapAuthResult, { ok: true }> & { scope: LocationScope }) | { ok: false; status: number; error: string }
> {
  const auth = await authenticateCapability(req, "matchops");
  if (!auth.ok) return auth;
  const scope = isConfined(auth.row) ? locationScopeForCity(auth.confinedCity) : auth.isAdmin ? POLAND : null;
  if (!scope) return { ok: false, status: 403, error: "No Locations market is set up for this account." };
  return { ...auth, scope };
}

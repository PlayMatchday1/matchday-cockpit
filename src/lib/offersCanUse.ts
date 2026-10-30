// May this user use Growth › Offers, for what to draw? The same answer as the server's matchOpsReadGate,
// which is what decides. canAccess alone says yes to a confined account (it keeps "matchops" for its own
// pages), and the server refuses those here. In its own file with no fetch, so the top nav importing it
// doesn't put /api/offers/access within reach of a confined account's pages.

import { isConfined } from "./cityConfinement";
import { canAccess, type AppUser } from "./useAuth";

export const canUseOffers = (u: AppUser | null): boolean =>
  !!u && !isConfined(u) && !u.is_service_account && !(u.is_city_manager === true && !u.is_admin) && canAccess(u, "matchops");

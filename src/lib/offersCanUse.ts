// May this user use Match Ops › Offers, for whether to ask the server at all? The same answer as the server's
// matchOpsReadGate, which is what decides. canAccess alone says yes to a confined account (it keeps "matchops"
// for its own pages), and the server refuses those here.

import { isConfined } from "./cityConfinement";
import { canAccess, type AppUser } from "./useAuth";

export const canUseOffers = (u: AppUser | null): boolean =>
  !!u && !isConfined(u) && !u.is_service_account && !(u.is_city_manager === true && !u.is_admin) && canAccess(u, "matchops");

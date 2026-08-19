"use client";

// Gameday Ops for a CITY MANAGER — the REAL board, scoped, read-only.
//
// WHAT THIS REPLACED. A bespoke rebuild reading a thin Supabase-mirror payload: a plain table with
// a summary strip. It could not have been the real board, because the mirror does not carry
// _count.fakePlayers, the fakeSpotLeft* ladder, autoCanceled or the team list — so the colour
// rails, the fake-spot countdown and the decide-by deadline had nothing to render from. The route
// now reads the same live API the admin board reads and returns the same rows, filtered to one
// city, so this page is the same GamedayBoard.
//
// READ-ONLY IS ABOUT WHAT CLICKING DOES, NOT HOW IT LOOKS. Same board, same rows, same rails, same
// grouping, same day nav, same filters. Clicking a match goes to its Manager Pay row instead of
// opening the match panel — and because onOpenMatch is set, the panel is never MOUNTED, so there
// is no roster fetch and no cancel preview behind it. Those routes refuse this tier as well; this
// is the UI half of the same statement.
//
// NO EXPLANATORY LINE. The old page carried "Read only: to change a match's manager, open it on
// Manager Pay". Clicking a match now does exactly that, which is a better way of saying it.

import { useRouter } from "next/navigation";
import { useAuth, isCityManager, canAccess } from "@/lib/useAuth";
import { cityNameFor } from "@/lib/cityScope";
import GamedayBoard from "@/components/GamedayBoard";
import { CITY_SECTIONS } from "../citySections";

export default function CityGamedayPage() {
  const { appUser, isLoading } = useAuth();
  const router = useRouter();

  if (isLoading) return <div className="p-6 text-sm text-deep-green/50">Loading…</div>;
  // THE CHECKBOX DECIDES — the same predicate the route enforces. This accepted Admin or the city
  // tier and never Match Ops, so a Match Ops holder was refused a page inside Match Ops.
  if (!isCityManager(appUser) && !canAccess(appUser ?? null, "matchops")) {
    return <div className="p-6 text-sm text-coral" data-testid="cg-denied">Gameday Ops needs Match Ops access. Ask an admin to tick it on the User access screen.</div>;
  }

  const lockedCity = cityNameFor(appUser?.city_identifier) ?? appUser?.city_identifier ?? null;

  return (
    <div data-testid="city-gameday" data-scope={appUser?.city_identifier ?? ""}>
      <GamedayBoard
        endpoint="/api/city/gameday"
        lockedCity={lockedCity}
        // The ONE write this tier gets is the manager assignment, and it lives on Manager Pay.
        // Sending the operator there is the whole read-only story: the thing you came to change is
        // one click away, on the page that is scoped, logged and read back. A HASH, not a param
        // that auto-opens the assign sheet — landing on the row is navigation, opening the write is
        // a decision the operator makes.
        onOpenMatch={(id) => router.push(`/city/manager-pay#match-${id}`)}
        nav={{ items: CITY_SECTIONS, title: "City" }}
      />
    </div>
  );
}

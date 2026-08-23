"use client";

// /match-ops on its own has no content — redirect to the landing sub-tab.
//
// Bare /match-ops lands on GAMEDAY OPS when the viewer can open it — that is what Match Ops means
// to someone tapping it — and otherwise on the first item in their own list, never a 403
// (Gameday Ops for anyone with matchops; the chats-only operator falls through to Match Chats,
// which is also Daily Ops). Previously this went to Master Schedule, which is now Back Office —
// landing there would drop an operator into the weeks-long rhythm rather than today's.
// firstSectionHref reads the same list the rail draws, so the landing target can never name a
// route the viewer cannot open.

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { firstAllowedPath, useAuth } from "@/lib/useAuth";
import { matchOpsLandingHref } from "./sections";

export default function MatchOpsIndex() {
  const { appUser, isLoading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (isLoading || !appUser) return;
    const landing = matchOpsLandingHref(appUser);
    if (landing) router.replace(landing);
    // THE FIELD-PIPELINE FALLBACK IS GONE WITH THE PAGE. It used to catch the tech-only viewer, and
    // sending them out of Match Ops entirely would be worse than the /no-access path
    // firstAllowedPath already picks for someone with nothing here to open.
    else router.replace(firstAllowedPath(appUser));
  }, [appUser, isLoading, router]);

  return null;
}

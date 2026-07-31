"use client";

// /match-ops on its own has no content — redirect to the first sub-tab the
// current user can access. If they can access neither, send them to their own
// first-allowed page (the top-level tab is hidden for them anyway, but typing
// the URL must not 500).

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { canAccess, firstAllowedPath, useAuth } from "@/lib/useAuth";

export default function MatchOpsIndex() {
  const { appUser, isLoading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (isLoading || !appUser) return;
    if (canAccess(appUser, "chats")) router.replace("/match-ops/chats");
    else if (canAccess(appUser, "clubhouse"))
      router.replace("/match-ops/field-pipeline");
    else router.replace(firstAllowedPath(appUser));
  }, [appUser, isLoading, router]);

  return null;
}

// /admin/finance has no content of its own — REVENUE is the landing section. A redirect, not a
// page: the rail needs one item to be the default.
//
// IT WAS CITIES, on the reasoning that Cities is the whole-estate view the other five drill out
// of. Revenue is the page actually opened first, and it is already FIRST in the rail
// (financeSections.tsx) — so the landing and the rail now agree instead of the tab dropping you
// on the third item.
//
// THIS IS THE ONLY PLACE THE DEFAULT LIVES. /admin/finance/cities and every other section keep
// their own routes and are unaffected: a deep link goes straight to its folder and never passes
// through here. Preserves ?q= so a quarter-bearing link still lands on the right quarter.
"use client";

import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

export default function FinanceIndexPage() {
  const router = useRouter();
  const params = useSearchParams();
  useEffect(() => {
    const qs = params?.toString();
    router.replace(qs ? `/admin/finance/revenue?${qs}` : "/admin/finance/revenue");
  }, [router, params]);
  return null;
}

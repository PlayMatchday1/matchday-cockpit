// /admin/finance has no content of its own — Cities is the landing section. A redirect, not a
// page: the rail needs one item to be the default and Cities is the whole-estate view the other
// five drill out of. Preserves ?q= so a quarter-bearing link still lands on the right quarter.
"use client";

import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

export default function FinanceIndexPage() {
  const router = useRouter();
  const params = useSearchParams();
  useEffect(() => {
    const qs = params?.toString();
    router.replace(qs ? `/admin/finance/cities?${qs}` : "/admin/finance/cities");
  }, [router, params]);
  return null;
}

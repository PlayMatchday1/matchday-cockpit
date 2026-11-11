"use client";

// Finance › Credits — admins only. See src/components/finance/CreditsView.tsx.
import { Suspense } from "react";
import CreditsView from "@/components/finance/CreditsView";

export default function Page() {
  return <Suspense fallback={null}><CreditsView /></Suspense>;
}

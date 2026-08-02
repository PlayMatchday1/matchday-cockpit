"use client";

// Slate Review — moved from Finance into Match Ops (2026-08). Gate unchanged:
// it carried page="finance" inside Finance, so it keeps that exact gate here.

import PagePermissionGuard from "@/components/PagePermissionGuard";
import SlateReviewView from "./SlateReviewView";

export const dynamic = "force-dynamic";

export default function SlateReviewPage() {
  return (
    <PagePermissionGuard page="finance">
      <SlateReviewView />
    </PagePermissionGuard>
  );
}

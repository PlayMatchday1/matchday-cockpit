import type { Metadata } from "next";
import PagePermissionGuard from "@/components/PagePermissionGuard";
import ReviewsClient from "./ReviewsClient";

// Consolidated Reviews — moved out of Growth → Cities (where it was split across
// three tabs) into Match Ops as one page. Gate is "cities" (the audience the
// Growth lens already had); ticking a reply is additionally admin-gated by RLS
// on review_replies. The old /growth?tab=reviews path (now /lifecycle) redirects here
// (next.config.ts).

export const metadata: Metadata = { title: "Reviews" };

export default function ReviewsPage() {
  return (
    <PagePermissionGuard page="matchops">
      <ReviewsClient />
    </PagePermissionGuard>
  );
}

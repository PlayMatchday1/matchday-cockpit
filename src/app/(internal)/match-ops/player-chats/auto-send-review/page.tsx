import type { Metadata } from "next";
import PagePermissionGuard from "@/components/PagePermissionGuard";
import AutoSendReview from "./AutoSendReview";

export const metadata: Metadata = { title: "Auto-send review" };

export default function AutoSendReviewPage() {
  return (
    <PagePermissionGuard page="chats">
      <AutoSendReview />
    </PagePermissionGuard>
  );
}

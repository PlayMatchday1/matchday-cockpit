import { Suspense } from "react";
import type { Metadata } from "next";
import AdminGuard from "@/components/AdminGuard";
import PageHeader from "@/components/PageHeader";
import SmsLogView from "./SmsLogView";

// Outbound SMS history dashboard. Admin-only (AdminGuard); the data
// holds recipient phones + message bodies (PII). Reads the local
// telnyx_sms_log cache via GET /api/sms-log, fed by the daily cron and
// the on-demand "fetch recent" trigger.

export const metadata: Metadata = {
  title: "SMS Log",
};

export const dynamic = "force-dynamic";

export default function SmsLogPage() {
  return (
    <AdminGuard>
      <PageHeader
        title="SMS Log"
        subtitle="Outbound texts sent through Telnyx, classified by type."
      />
      <Suspense fallback={null}>
        <SmsLogView />
      </Suspense>
    </AdminGuard>
  );
}

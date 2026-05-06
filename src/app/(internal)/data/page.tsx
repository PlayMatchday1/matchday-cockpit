"use client";

import PageHeader from "@/components/PageHeader";
import PagePermissionGuard from "@/components/PagePermissionGuard";
import MatchesUploader from "@/components/MatchesUploader";
import StripeUploader from "@/components/StripeUploader";
import SyncCard from "@/components/SyncCard";
import { canAccess, useAuth } from "@/lib/useAuth";

export default function DataPage() {
  const { appUser } = useAuth();
  // Stripe + Members write to finance-domain tables (fin_revenue,
  // mdapi_subscriptions), so they only render for users with finance
  // access. Matches + Reviews remain available to anyone with data
  // access.
  const showFinanceSections = canAccess(appUser, "finance");

  return (
    <PagePermissionGuard page="data">
      <PageHeader
        title="Data"
        subtitle="Upload CSVs and run on-demand syncs."
      />

      {showFinanceSections && (
        <>
          <section className="mb-12">
            <SectionHeader
              title="Stripe data"
              subtitle="Charges and subscription payments. Synced automatically from Stripe."
            />
            <StripeUploader />
          </section>

          <section className="mb-12">
            <SectionHeader
              title="Members data"
              subtitle="Active subscribers and cancellations from Stripe."
            />
            <SyncCard
              title="Sync from MatchDay API"
              description="Refreshes mdapi_subscriptions from /admin/subscriptions across all cities."
              source="mdapi-subscriptions"
              endpoint="/api/sync/subscriptions"
              estimatedDuration="~60 seconds"
            />
          </section>
        </>
      )}

      <section className="mb-12">
        <SectionHeader
          title="Matches data"
          subtitle="Match registrations and cancellations."
        />
        <MatchesUploader />
      </section>

      <section>
        <SectionHeader
          title="Reviews data"
          subtitle="Star ratings and manager attribution."
        />
        <SyncCard
          title="Sync from MatchDay API"
          description="Refreshes mdapi_reviews from /admin/matches/reviews."
          source="mdapi-reviews"
          endpoint="/api/sync/reviews"
        />
      </section>
    </PagePermissionGuard>
  );
}

function SectionHeader({
  title,
  subtitle,
}: {
  title: string;
  subtitle: string;
}) {
  return (
    <div className="mb-5 flex items-stretch gap-3">
      <span aria-hidden className="w-1 rounded-full bg-mint" />
      <div className="py-0.5">
        <h2 className="text-2xl font-bold tracking-tight text-deep-green">
          {title}
        </h2>
        <p className="mt-0.5 text-sm text-deep-green/60">{subtitle}</p>
      </div>
    </div>
  );
}

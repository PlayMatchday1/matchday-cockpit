"use client";

import PageHeader from "@/components/PageHeader";
import PagePermissionGuard from "@/components/PagePermissionGuard";
import StripeUploader from "@/components/StripeUploader";
import SyncCard from "@/components/SyncCard";
import { canAccess, useAuth } from "@/lib/useAuth";

export default function DataPage() {
  const { appUser } = useAuth();
  // Sections gated on finance access write to finance-domain tables
  // (fin_revenue, mdapi_subscriptions, members_monthly_snapshots) or
  // surface finance-y data. Reviews + Matches stay open to data
  // permission since they feed both finance and ops dashboards.
  const showFinanceSections = canAccess(appUser, "finance");

  return (
    <PagePermissionGuard page="data">
      <PageHeader
        title="Data"
        subtitle="Upload CSVs and run on-demand syncs."
      />

      {/* Section order matches the cron orchestrator's daily run:
          stripe → reviews → subscriptions → promocodes → matches →
          users → snapshots. Each card surfaces its last fin_sync_log
          row so operators can see freshness at a glance. */}

      {/* 1. Stripe */}
      {showFinanceSections && (
        <section className="mb-12">
          <SectionHeader
            title="Stripe data"
            subtitle="Charges and subscription payments. Synced automatically from Stripe."
          />
          <StripeUploader />
        </section>
      )}

      {/* 2. Reviews */}
      <section className="mb-12">
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

      {/* 3. Members / Subscriptions */}
      {showFinanceSections && (
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
      )}

      {/* 4. Promocodes (NEW Phase 5b followup) */}
      {showFinanceSections && (
        <section className="mb-12">
          <SectionHeader
            title="Promocodes"
            subtitle="Promo code metadata — resolves promocode_id → code text in match insights."
          />
          <SyncCard
            title="Sync from MatchDay API"
            description="Refreshes mdapi_promocodes from /admin/promocodes (~6k rows)."
            source="mdapi-promocodes"
            endpoint="/api/sync/promocodes"
            estimatedDuration="~2 seconds"
          />
        </section>
      )}

      {/* 5. Matches */}
      <section className="mb-12">
        <SectionHeader
          title="Matches data"
          subtitle="Match registrations and player rosters."
        />
        <SyncCard
          title="Sync from MatchDay API (incremental)"
          description="Refreshes mdapi_matches + mdapi_match_players for the now-14d → now+60d window. The full backfill is CLI-only via scripts/sync-mdapi-matches-backfill.ts."
          source="mdapi-matches"
          endpoint="/api/sync/matches"
          estimatedDuration="~150 seconds"
        />
      </section>

      {/* 6. Registered users (full re-sync) */}
      <section className="mb-12">
        <SectionHeader
          title="Registered users data"
          subtitle="Every MatchDay account, including users who never played a match."
        />
        <SyncCard
          title="Sync Registered Users"
          description="Pulls all registered users from MatchDay API into mdapi_users (~23,711 rows). Full re-sync each run — paginates /admin/players at limit=250."
          source="mdapi-users"
          endpoint="/api/sync/users"
          estimatedDuration="~30-60 seconds"
        />
        <div className="mt-4">
          <SyncCard
            title="Refresh Users lens snapshot"
            description="Pre-aggregates the Cities → Users lens for stable windows (All time, 2026 YTD, last 90, last 12mo, plus 2025/2024 retroactive). Replaces the live ~4.6s cold load with a ~150ms snapshot read."
            source="mdapi-users-lens-snapshot"
            endpoint="/api/sync/users-lens-snapshot"
            estimatedDuration="~6 seconds"
          />
        </div>
      </section>

      {/* 7. Membership snapshots (NEW Phase 5c) */}
      {showFinanceSections && (
        <section>
          <SectionHeader
            title="Membership snapshots"
            subtitle="Per-month rollup driving the All-Time chart and historical KPIs."
          />
          <SyncCard
            title="Refresh snapshots"
            description="Recomputes members_monthly_snapshots from mdapi_subscriptions + mdapi_match_players. Useful after a data spot-fix; the cron also runs this nightly."
            source="membership-snapshots"
            endpoint="/api/sync/snapshots"
            estimatedDuration="~5 seconds"
          />
        </section>
      )}
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

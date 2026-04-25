import Link from "next/link";
import { notFound } from "next/navigation";
import CityGoalsView from "@/components/CityGoalsView";
import PageHeader from "@/components/PageHeader";
import { CityHealthPill } from "@/components/StatusPill";
import { CITY_STATS, cityFromSlug } from "@/lib/types";

export default async function CityDetailPage({
  params,
}: {
  params: Promise<{ city: string }>;
}) {
  const { city: slug } = await params;
  const city = cityFromSlug(slug);
  if (!city) notFound();

  const stats = CITY_STATS[city];

  return (
    <>
      <div className="mb-2 text-sm">
        <Link
          href="/cities"
          className="text-deep-green/60 transition hover:text-deep-green"
        >
          ← All cities
        </Link>
      </div>

      <PageHeader title={city} subtitle="Market dashboard and city goals." />

      <div className="mb-10 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-cream-line bg-cream-soft p-4">
          <div className="text-xs font-semibold uppercase tracking-wider text-deep-green/60">
            Venues
          </div>
          <div className="mt-1 text-2xl font-extrabold tabular-nums text-deep-green">
            {stats.venues}
          </div>
        </div>
        <div className="rounded-xl border border-cream-line bg-cream-soft p-4">
          <div className="text-xs font-semibold uppercase tracking-wider text-deep-green/60">
            Matches per week
          </div>
          <div className="mt-1 text-2xl font-extrabold tabular-nums text-deep-green">
            {stats.matchesPerWeek}
          </div>
        </div>
        <div className="rounded-xl border border-cream-line bg-cream-soft p-4">
          <div className="text-xs font-semibold uppercase tracking-wider text-deep-green/60">
            Status
          </div>
          <div className="mt-2">
            <CityHealthPill health={stats.health} />
          </div>
        </div>
      </div>

      <div className="mb-4">
        <h2 className="text-2xl font-extrabold tracking-tight text-deep-green">
          {city} goals
        </h2>
        <p className="text-sm text-deep-green/60">
          City-specific objectives and progress.
        </p>
      </div>
      <CityGoalsView city={city} />
    </>
  );
}

import Link from "next/link";
import PageHeader from "@/components/PageHeader";
import { CityHealthPill } from "@/components/StatusPill";
import { CITIES, CITY_STATS, citySlug } from "@/lib/types";

export default function CitiesIndexPage() {
  return (
    <>
      <PageHeader
        title="Cities"
        subtitle="Per-market venues, weekly matches, and goals."
      />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {CITIES.map((city) => {
          const s = CITY_STATS[city];
          return (
            <Link
              key={city}
              href={`/cities/${citySlug(city)}`}
              className="block rounded-xl border border-cream-line bg-cream-soft p-5 shadow-sm transition hover:shadow-md"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="text-base font-bold text-deep-green">
                  {city}
                </div>
                <CityHealthPill health={s.health} />
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wider text-deep-green/60">
                    Venues
                  </dt>
                  <dd className="text-lg font-extrabold tabular-nums text-deep-green">
                    {s.venues}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wider text-deep-green/60">
                    Matches / wk
                  </dt>
                  <dd className="text-lg font-extrabold tabular-nums text-deep-green">
                    {s.matchesPerWeek}
                  </dd>
                </div>
              </dl>
            </Link>
          );
        })}
      </div>
    </>
  );
}

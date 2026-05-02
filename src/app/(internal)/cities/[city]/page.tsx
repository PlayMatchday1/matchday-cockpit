import { notFound } from "next/navigation";
import CityDetailView from "@/components/CityDetailView";
import PagePermissionGuard from "@/components/PagePermissionGuard";
import { cityFromSlug } from "@/lib/types";

export default async function CityDetailPage({
  params,
}: {
  params: Promise<{ city: string }>;
}) {
  const { city: slug } = await params;
  const city = cityFromSlug(slug);
  if (!city) notFound();
  return (
    <PagePermissionGuard page="cities">
      <CityDetailView city={city} />
    </PagePermissionGuard>
  );
}

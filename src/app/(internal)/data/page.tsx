import PageHeader from "@/components/PageHeader";
import PagePermissionGuard from "@/components/PagePermissionGuard";
import MatchesUploader from "@/components/MatchesUploader";
import ReviewsUploader from "@/components/ReviewsUploader";

export default function DataPage() {
  return (
    <PagePermissionGuard page="data">
      <PageHeader
        title="Data"
        subtitle="Upload CSVs from Retool. Each upload replaces the previous one for that data type."
      />

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
        <ReviewsUploader />
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

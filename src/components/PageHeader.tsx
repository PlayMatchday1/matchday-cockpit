export default function PageHeader({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="mb-6">
      <h1 className="text-3xl font-extrabold tracking-tight text-deep-green">
        {title}
      </h1>
      {subtitle && (
        <p className="mt-1 text-sm text-deep-green/70">{subtitle}</p>
      )}
    </div>
  );
}

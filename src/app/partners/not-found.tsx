// Generic 404 for the partner namespace. Rendered when a slug doesn't
// resolve OR when its dashboard is disabled — same response either way
// so we don't leak which case it is.

export default function PartnersNotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center px-6 text-center">
      <h1 className="font-display text-5xl uppercase leading-none tracking-tight text-deep-green">
        Dashboard not found
      </h1>
      <p className="mt-4 text-sm text-deep-green/65">
        This dashboard link is invalid or no longer active. If you believe
        this is wrong, please contact your MatchDay partner contact.
      </p>
    </main>
  );
}

import type { Metadata } from "next";

// Standalone public layout for /managers. Deliberately omits AuthGate
// and the cockpit nav — this URL is meant to be sharable with city
// managers, who do not have cockpit sessions.

export const metadata: Metadata = {
  title: "Match Manager Schedule & Pay — MatchDay",
  description:
    "Weekly schedule of matches, assigned managers, and pay. Updated daily.",
  robots: { index: false, follow: false },
};

export default function ManagersLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="min-h-screen bg-cream font-sans text-deep-green">
      <div className="mx-auto max-w-7xl px-4 py-8 md:px-6 md:py-10">
        {children}
      </div>
    </div>
  );
}

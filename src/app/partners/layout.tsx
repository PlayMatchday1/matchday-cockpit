import type { Metadata } from "next";

// Standalone layout for partner-facing dashboards. Deliberately does
// NOT include AuthGate, the cockpit nav, or any internal chrome —
// partners see ONLY this tree.

export const metadata: Metadata = {
  title: "MatchDay — Partner Dashboard",
  description: "Live MatchDay partner dashboard.",
  robots: { index: false, follow: false },
};

export default function PartnersLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="min-h-screen bg-cream font-sans text-deep-green">
      {children}
    </div>
  );
}

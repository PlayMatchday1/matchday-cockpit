import type { Metadata } from "next";

// Page-scoped browser-tab title for the Growth section (formerly Cities). The
// page is a client component and can't export metadata, so it lives here.
export const metadata: Metadata = {
  title: "Growth",
};

import GrowthShell from "./GrowthShell";

// The shell is a client component (rail state, provider); this stays a server layout so the tab
// title above can still be exported.
export default function GrowthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <GrowthShell>{children}</GrowthShell>;
}

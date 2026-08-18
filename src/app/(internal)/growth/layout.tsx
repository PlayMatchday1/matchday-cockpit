import type { Metadata } from "next";

// Page-scoped browser-tab title for the Player Lifecycle section (named Growth until the
// Membership move, and Cities before that; the route has been /growth throughout). The page is a
// client component and can't export metadata, so it lives here.
export const metadata: Metadata = {
  title: "Player Lifecycle",
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

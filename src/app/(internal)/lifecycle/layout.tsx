import type { Metadata } from "next";

// Page-scoped browser-tab title for the Player Lifecycle section (named Growth until the
// Membership move, and Cities before that; the route was /growth until 2026-08-23, when it moved
// to /lifecycle so the Growth tab could have its own name). The page is a client component and
// can't export metadata, so it lives here.
export const metadata: Metadata = {
  title: "Player Lifecycle",
};

import LifecycleShell from "./LifecycleShell";

// The shell is a client component (rail state, provider); this stays a server layout so the tab
// title above can still be exported.
export default function LifecycleLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <LifecycleShell>{children}</LifecycleShell>;
}

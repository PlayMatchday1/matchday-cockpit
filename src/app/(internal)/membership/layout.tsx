import type { Metadata } from "next";

// Membership is a section of PLAYER LIFECYCLE now, not a top-nav tab of its own — but it stays at
// /membership. Moving the URL under /growth would 308 every existing bookmark to buy nothing: the
// rail does not care what the path says.
//
// This layout exists so the page renders inside that rail. The page is a client component and
// cannot export metadata, so the tab title lives here — same split as the Growth layout.
export const metadata: Metadata = {
  title: "Membership · Player Lifecycle",
};

import MembershipShell from "./MembershipShell";

export default function MembershipLayout({ children }: { children: React.ReactNode }) {
  return <MembershipShell>{children}</MembershipShell>;
}

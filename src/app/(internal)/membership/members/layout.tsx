import type { Metadata } from "next";

// The page is a client component and cannot export metadata, so the tab title lives here — the
// same split Members by City uses. The chrome (guard + Player Lifecycle rail) comes from the parent
// /membership layout.
export const metadata: Metadata = {
  title: "Members · Membership",
};

export default function MembersLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

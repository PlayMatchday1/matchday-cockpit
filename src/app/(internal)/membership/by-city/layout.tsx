import type { Metadata } from "next";

// The page is a client component and cannot export metadata, so the tab title lives here — the
// same split /membership itself uses. The chrome comes from the parent /membership layout.
export const metadata: Metadata = {
  title: "Members by City · Membership",
};

export default function MembersByCityLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

import type { Metadata } from "next";

// Page-scoped browser-tab title for the Growth section (formerly Cities). The
// page is a client component and can't export metadata, so it lives here.
export const metadata: Metadata = {
  title: "Growth",
};

export default function GrowthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}

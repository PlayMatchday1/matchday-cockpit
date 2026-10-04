import type { Metadata } from "next";

// The page is a client component and cannot export metadata, so the tab title lives here. The
// chrome comes from the parent /growth layout.
export const metadata: Metadata = {
  title: "2027 Growth Plan · Growth",
};

export default function OpsPlanLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

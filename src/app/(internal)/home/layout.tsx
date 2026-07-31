import type { Metadata } from "next";

// Page-scoped browser-tab title for the Home page. The page component itself is
// "use client" and can't export metadata, so the title lives here. This
// overrides the root layout's app-level title ("MD Clubhouse", the product
// name) for /home only — other routes keep the product title.
export const metadata: Metadata = {
  title: "Home",
};

export default function HomeLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}

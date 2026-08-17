import type { Metadata } from "next";

// Page-scoped browser-tab title for Finance. The shell is a client component (rail state, quarter
// provider) and cannot export metadata, so it lives here — same split as the Growth layout.
export const metadata: Metadata = {
  title: "Finance",
};

import FinanceShell from "./FinanceShell";

export default function FinanceLayout({ children }: { children: React.ReactNode }) {
  return <FinanceShell>{children}</FinanceShell>;
}

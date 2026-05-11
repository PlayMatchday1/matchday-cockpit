import ManagersView from "./ManagersView";

// Server component shell — defers the entire interactive UI to a
// client component. No data is fetched here; the client component
// reads /api/manager-pay/week (public, with emails stripped for
// non-admin callers).

export const dynamic = "force-dynamic";

export default function ManagersPage() {
  return <ManagersView />;
}

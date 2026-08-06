// Public shareable Manager Pay page — /pay/<token>. Lives OUTSIDE the (internal)
// route group, so it never touches AuthGate/TopNav and needs no login. All data
// comes from the token-authed /api/manager-pay/shared endpoint; a wrong or rotated
// token renders the "link no longer valid" state (the endpoint 404s).

import SharedManagerPayView from "./SharedManagerPayView";

export const dynamic = "force-dynamic";
export const metadata = { title: "Manager Pay", robots: { index: false, follow: false } };

export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <SharedManagerPayView token={token} />;
}

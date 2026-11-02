import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { localModeOn } from "@/lib/localMode";
import { isReviewToken, reviewRefusal } from "@/lib/reviewAccount";

// Next 16: this file replaces the historical `middleware.ts`. Today
// it's a no-op pass-through, but it explicitly declares /partners/* as
// a public namespace via the matcher's negative lookahead. If anyone
// later adds auth checks at this layer (cookie verification, IP
// blocking, etc.), partner routes are exempted by file convention.

export function proxy(request: NextRequest) {
  const { pathname, searchParams } = request.nextUrl;
  // THE APP STORE REVIEW ACCOUNT IS READ ONLY, on every API route at once (lib/reviewAccount.ts).
  // Everyone else's API requests pass straight through, except sync triggers in local mode.
  if (pathname.startsWith("/api/")) {
    if (isReviewToken(request.headers.get("authorization"))) {
      const refusal = reviewRefusal(request.method, pathname);
      if (refusal) return NextResponse.json({ error: refusal.error }, { status: refusal.status });
    }
    // LOCAL MODE (src/lib/localMode.ts): every sync trigger is a no-op. The route never runs, so it
    // cannot write production Supabase, whatever it would have read. Off, sync paths pass straight
    // through. (Merged 2026-11-02: this sat after main's /api/ early return, which would have skipped it.)
    if ((pathname === "/api/sync" || pathname.startsWith("/api/sync/")) && localModeOn()) {
      return NextResponse.json(
        { ok: false, error: "Sync is disabled in local mode (MATCHDAY_LOCAL_API=1 under next dev). Nothing ran." },
        { status: 503 },
      );
    }
    return NextResponse.next();
  }
  // Field Ops lost its ?fo= tab strip. These land the old deep links on their new
  // homes and STRIP the now-meaningless fo param — done here rather than in
  // next.config because a config redirect passes the query through, which both
  // leaves an ugly ?fo= on the destination and makes fo=fields → field-ops loop.
  if (pathname === "/match-ops/field-ops" && searchParams.has("fo")) {
    const fo = searchParams.get("fo");
    const dest = request.nextUrl.clone();
    dest.searchParams.delete("fo");
    if (fo === "inventory") dest.pathname = "/match-ops/inventory";
    else if (fo === "veo" || fo === "community") dest.pathname = "/match-ops/match-chats/automation";
    // fo === "fields" (or anything else): stay on Field Ops, param stripped.
    return NextResponse.redirect(dest, 308);
  }
  return NextResponse.next();
}

export const config = {
  // Match everything EXCEPT static assets, API routes, AND partners/*.
  // Belt-and-suspenders alongside the route-group structural isolation.
  matcher: [
    "/((?!_next/static|_next/image|favicon\\.ico|matchday-badge\\.svg|api|partners).*)",
    // The API: the review account's read-only check, and the local-mode sync no-op (/api/sync/*).
    "/api/:path*",
  ],
};

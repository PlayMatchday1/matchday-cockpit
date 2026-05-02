import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Next 16: this file replaces the historical `middleware.ts`. Today
// it's a no-op pass-through, but it explicitly declares /partners/* as
// a public namespace via the matcher's negative lookahead. If anyone
// later adds auth checks at this layer (cookie verification, IP
// blocking, etc.), partner routes are exempted by file convention.

export function proxy(_request: NextRequest) {
  return NextResponse.next();
}

export const config = {
  // Match everything EXCEPT static assets, API routes, AND partners/*.
  // Belt-and-suspenders alongside the route-group structural isolation.
  matcher: [
    "/((?!_next/static|_next/image|favicon\\.ico|matchday-badge\\.svg|api|partners).*)",
  ],
};

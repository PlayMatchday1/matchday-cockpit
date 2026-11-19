// GET /api/admin/disputes: every Stripe dispute (US account) from the last year, matched to members, with the
// page's top cards. Admins only. Read only; cached in disputesServer (3 minutes, one read in flight).
// The list carries no IP, device or email: those appear only in /api/admin/disputes/[id].
import { authenticateAdmin } from "@/lib/adminAuth";
import { listDisputes, DisputesReadError } from "@/lib/disputesServer";
import { StripeConfigError } from "@/lib/stripePayments";
import type { DisputeRow } from "@/lib/disputesModel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DAY = 86_400_000;

export async function GET(req: Request) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const fresh = new URL(req.url).searchParams.get("fresh") === "1";
  try {
    const { rows, readAt } = await listDisputes({ fresh });
    const since90 = Date.now() - 90 * DAY;
    const byDue = (a: DisputeRow, b: DisputeRow) => (a.dueBy ?? "9").localeCompare(b.dueBy ?? "9") || b.createdAt.localeCompare(a.createdAt);
    const needs = rows.filter((r) => r.bucket === "needs_response").sort(byDue);
    const review = rows.filter((r) => r.bucket === "under_review").sort(byDue);
    const closed = rows.filter((r) => r.bucket === "closed" && new Date(r.createdAt).getTime() >= since90)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const sum = (xs: DisputeRow[]) => xs.reduce((s, r) => s + r.amountCents, 0);
    const won = closed.filter((r) => r.status === "won");
    const lost = closed.filter((r) => r.status === "lost");
    return Response.json({
      readAt,
      tabs: { needs_response: needs, under_review: review, closed },
      cards: {
        needsResponse: needs.length,
        nextDueBy: needs.find((r) => r.dueBy)?.dueBy ?? null,
        underReview: review.length,
        won90: { count: won.length, cents: sum(won) },
        lost90: { count: lost.length, cents: sum(lost) },
      },
    });
  } catch (e) {
    if (e instanceof StripeConfigError) return Response.json({ error: "Stripe is not configured on this server." }, { status: 503 });
    const msg = e instanceof DisputesReadError ? e.message : "The dispute list could not be read.";
    return Response.json({ error: msg }, { status: 502 });
  }
}

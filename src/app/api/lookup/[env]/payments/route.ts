// Player Lookup — live Stripe payments (Phase 18). READ ONLY, NEVER cached. A separate
// endpoint from the profile so it is an independent live call per profile view and can
// fail on its own without blanking the rest of the page. MATCH OPS READ-gated as of Part D
// round 2 — support answers "why was I charged twice", and cannot do that blind; reuses
// STRIPE_SECRET_KEY server-side via stripePayments — the key is never in the response,
// never logged, never in an error string.

import { authenticateMatchOpsRead } from "@/lib/matchOpsAuth"; // Part D round 2 — a Match Ops READ (was is_admin)
import { fetchPlayerPayments, StripeConfigError, StripeUnreachableError } from "@/lib/stripePayments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const isEnv = (x: string): boolean => x === "staging" || x === "production";

export async function GET(req: Request, ctx: { params: Promise<{ env: string }> }) {
  const auth = await authenticateMatchOpsRead(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { env } = await ctx.params;
  if (!isEnv(env)) return Response.json({ error: `unknown environment ${JSON.stringify(env)}` }, { status: 400 });

  const url = new URL(req.url);
  const email = url.searchParams.get("email");
  const userId = url.searchParams.get("id"); // the MatchDay player id, for the metadata.userId route
  if (!email && !userId) return Response.json({ error: "email or id required" }, { status: 400 });

  try {
    const result = await fetchPlayerPayments(email, userId);
    // no-store on top of dynamic — belt and suspenders against any cache of live money state
    return new Response(JSON.stringify({ ok: true, ...result, email }), {
      status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  } catch (e) {
    if (e instanceof StripeConfigError) {
      console.error("[payments] Stripe key not configured"); // no value, no key
      return Response.json({ ok: false, error: "Stripe is not configured on the server. Payments cannot be read right now.", kind: "config" }, { status: 500 });
    }
    if (e instanceof StripeUnreachableError) {
      console.error(`[payments] Stripe unreachable: ${e.message}`);
      return Response.json({ ok: false, error: `Stripe is unreachable right now: ${e.message}`, kind: "unreachable" }, { status: 502 });
    }
    console.error(`[payments] error: ${e instanceof Error ? e.message.slice(0, 160) : "unknown"}`);
    return Response.json({ ok: false, error: "Could not read payments.", kind: "unreachable" }, { status: 502 });
  }
}

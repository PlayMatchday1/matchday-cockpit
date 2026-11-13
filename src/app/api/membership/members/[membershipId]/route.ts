// THE MEMBER PANEL'S EXTRA READS — everything the panel needs that the player read does not carry.
//
//   GET ?env=production|staging[&sub=sub_…]
//
// Returns: the Stripe subscription read live (status, whether Stripe is scheduled to end it, when,
// the card), the last paid membership charge and the open failed one from our Stripe tables, the
// end facts the nightly job stored, and who last saved the comment (from our change log).
//
// The player read itself (strikes with reasons, the numeric membership id, the exact amount) is the
// existing GET /api/lookup/{env}?id=, which the panel calls alongside this.
//
// Stripe is read with GET only. The subscription id comes from our own paid invoices; a `sub` the
// client passes is used only when we hold none (staging), and only if it has Stripe's shape.
import { authenticateCapability } from "@/lib/capabilityAuth";
import { makeServerClient } from "@/lib/supabaseServer";
import { loadMemberRows, loadRowStripe, readStripeMember, stripeSubIdFor, commentMeta } from "@/lib/membersPageData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: Request, ctx: { params: Promise<{ membershipId: string }> }) {
  const auth = await authenticateCapability(req, "membership");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { membershipId } = await ctx.params;
  if (!/^\d+$/.test(membershipId)) return Response.json({ error: "membershipId must be numeric" }, { status: 400 });
  const url = new URL(req.url);
  const env = url.searchParams.get("env");
  if (env !== "production" && env !== "staging") return Response.json({ error: "env must be production or staging" }, { status: 400 });
  const id = Number(membershipId);
  const sb = makeServerClient();
  try {
    // CONFINEMENT: the membership must belong to the account's city, checked on our own copy.
    const { rows } = await loadMemberRows(env, sb);
    const row = rows.find((r) => r.membershipId === id) ?? null;
    if (!row) return Response.json({ error: `Membership ${id} is not in the member list.` }, { status: 404 });
    if (auth.confinedCity && row.city !== auth.confinedCity) return Response.json({ error: "That member is outside your city." }, { status: 403 });

    const [ours, facts, meta] = await Promise.all([
      env === "production" ? stripeSubIdFor(sb, id) : Promise.resolve({ subId: null, lastPaid: null }),
      loadRowStripe(sb, env, [id]),
      commentMeta(sb, env, id),
    ]);
    const passed = url.searchParams.get("sub");
    const subId = ours.subId ?? (passed && /^sub_[A-Za-z0-9]{6,}$/.test(passed) ? passed : null);
    const stripe = await readStripeMember(subId);
    return Response.json({
      membershipId: id, subscriptionId: subId, stripe, lastPaid: ours.lastPaid,
      stored: facts.get(id) ?? null, comment: { text: row.comment, by: meta.by, at: meta.at },
    });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

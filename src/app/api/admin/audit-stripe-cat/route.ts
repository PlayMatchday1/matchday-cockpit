// TEMPORARY one-off audit route. Pulls all Stripe charges in Apr 1-14
// 2026 (UTC) and reports how the production sync would categorize the
// non-standard payment types (captain fees, team registration fees,
// guest match fees, special events). Read-only — no fin_revenue writes.
//
// Auth: same dual-mode as /api/sync/stripe (user JWT or CRON_SECRET).
// Remove this file once the audit results are captured.

import { timingSafeEqual } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";
import { isStrikeCharge, looksLikeMembership } from "@/lib/financeImport";

export const maxDuration = 120;
export const runtime = "nodejs";

function constantTimeMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

type Tag = "captain" | "team" | "guest_match" | "special_event";

function tagsFor(meta: Stripe.Metadata): Tag[] {
  const tags: Tag[] = [];
  if (meta.captainDivisionId) tags.push("captain");
  if (meta.teamName || meta.teamId || meta.playerTeamId) tags.push("team");
  if (meta.guestUserMatchId) tags.push("guest_match");
  if (typeof meta.type === "string" && /event/i.test(meta.type)) tags.push("special_event");
  return tags;
}

function classify(meta: Stripe.Metadata, description: string | null): "DPP" | "Membership" | "Strike" {
  const t = (typeof meta.type === "string" && meta.type.trim()) ? meta.type.trim() : null;
  const ci = (typeof meta.cityIdentifier === "string" && meta.cityIdentifier.trim()) ? meta.cityIdentifier.trim() : null;
  if (isStrikeCharge(t)) return "Strike";
  if (looksLikeMembership(t, description, ci)) return "Membership";
  return "DPP";
}

export async function POST(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) {
    return Response.json({ error: "Missing Authorization header" }, { status: 401 });
  }
  const token = auth.slice("Bearer ".length).trim();
  const cronSecret = process.env.CRON_SECRET;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    return Response.json({ error: "Supabase env not configured" }, { status: 500 });
  }
  if (!(cronSecret && constantTimeMatch(token, cronSecret))) {
    const sb = createClient(supabaseUrl, supabaseKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await sb.auth.getUser(token);
    if (error || !data?.user) {
      return Response.json({ error: "Invalid session" }, { status: 401 });
    }
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    return Response.json({ error: "STRIPE_SECRET_KEY not set" }, { status: 500 });
  }
  const stripe = new Stripe(stripeKey);

  const since = Math.floor(Date.UTC(2026, 3, 1) / 1000);
  const until = Math.floor(Date.UTC(2026, 3, 15) / 1000) - 1;

  type Sample = {
    id: string;
    date: string;
    status: string;
    amount: number;
    currency: string;
    bucket: string;
    type_meta: string | null;
    cityIdentifier: string | null;
    description: string | null;
    relevant_meta: Record<string, string>;
  };
  type TagAgg = {
    count: number;
    gross: number;
    skipped: number;
    buckets: Record<string, number>;
    samples: Sample[];
  };
  const totals: Record<Tag, TagAgg> = {
    captain: { count: 0, gross: 0, skipped: 0, buckets: {}, samples: [] },
    team: { count: 0, gross: 0, skipped: 0, buckets: {}, samples: [] },
    guest_match: { count: 0, gross: 0, skipped: 0, buckets: {}, samples: [] },
    special_event: { count: 0, gross: 0, skipped: 0, buckets: {}, samples: [] },
  };
  let totalCharges = 0;
  let totalSucceededUsd = 0;
  let totalSkippedNonPaid = 0;
  let totalSkippedNonUsd = 0;
  const skippedWithTags: { id: string; status: string; amount: number; tags: Tag[]; meta_type: string | null }[] = [];

  for await (const c of stripe.charges.list({ created: { gte: since, lte: until }, limit: 100 })) {
    totalCharges++;
    const meta = c.metadata ?? {};
    const tags = tagsFor(meta);
    const isSkippedNonPaid = c.status !== "succeeded";
    const isNonUsd = !isSkippedNonPaid && c.currency?.toLowerCase() !== "usd";
    if (isSkippedNonPaid) totalSkippedNonPaid++;
    else if (isNonUsd) totalSkippedNonUsd++;
    else totalSucceededUsd++;

    if (tags.length === 0) continue;
    const bucket = (isSkippedNonPaid || isNonUsd)
      ? `SKIPPED:${isSkippedNonPaid ? c.status : "non-usd"}`
      : classify(meta, c.description?.trim() ?? null);

    for (const tag of tags) {
      const t = totals[tag];
      t.count++;
      if (isSkippedNonPaid || isNonUsd) t.skipped++;
      else t.gross += c.amount / 100;
      t.buckets[bucket] = (t.buckets[bucket] ?? 0) + 1;
      if (t.samples.length < 5) {
        t.samples.push({
          id: c.id,
          date: new Date(c.created * 1000).toISOString().slice(0, 10),
          status: c.status,
          amount: c.amount / 100,
          currency: c.currency ?? "",
          bucket,
          type_meta: typeof meta.type === "string" ? meta.type : null,
          cityIdentifier: typeof meta.cityIdentifier === "string" ? meta.cityIdentifier : null,
          description: c.description ?? null,
          relevant_meta: Object.fromEntries(
            Object.entries(meta).filter(([k]) =>
              /captain|team|guest|division|event/i.test(k) ||
              k === "type" || k === "cityIdentifier" || k === "matchName"
            ),
          ) as Record<string, string>,
        });
      }
    }
    if (isSkippedNonPaid) {
      skippedWithTags.push({ id: c.id, status: c.status, amount: c.amount / 100, tags, meta_type: typeof meta.type === "string" ? meta.type : null });
    }
  }

  return Response.json({
    window: { since_iso: "2026-04-01", until_iso: "2026-04-14 23:59:59 UTC" },
    overall: {
      totalCharges,
      succeededUsd: totalSucceededUsd,
      skippedNonPaid: totalSkippedNonPaid,
      skippedNonUsd: totalSkippedNonUsd,
    },
    by_tag: totals,
    skippedWithTags,
  });
}

// POST /api/community/post — the scheduled job. Called every 15 min by
// Supabase pg_cron (pg_net) with the shared secret. Posts a WhatsApp community
// invite (2 messages) into the chat of each match that just finished, exactly
// once, subject to four guards. Also the dry-run preview endpoint.
//
// Auth: shared secret COMMUNITY_POST_SECRET, sent as `Authorization: Bearer
// <secret>` (or `x-community-secret`), constant-time compared.
//
// ?dry=1  → returns exactly what it WOULD post (match ids, cities, full
//           message bodies) and writes NOTHING (no Firestore, no audit, no
//           heartbeat). Run this first.

import { timingSafeEqual } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  classifyCommunityMatches,
  COMMUNITY_LOOKBACK_HOURS,
  COMMUNITY_START_POSTING_AFTER,
} from "@/lib/community";
import {
  loadAlreadyPosted,
  loadCommunityMaps,
  loadCommunitySettings,
  loadRecentlyFinishedMatches,
  markHeartbeatAttempt,
  markHeartbeatResult,
  postCommunityInvite,
} from "@/lib/communityData";

export const runtime = "nodejs";
export const maxDuration = 60;

// Bound a single run's duration: post at most this many per invocation; any
// remainder is picked up (idempotently) on the next 15-min run. In steady
// state runs post 0–few, so this only ever bites a large self-heal catch-up.
const MAX_POSTS_PER_RUN = 25;

function constantTimeMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function readSecret(req: Request): string | null {
  const header = req.headers.get("authorization") ?? "";
  if (header.startsWith("Bearer ")) return header.slice("Bearer ".length).trim();
  const x = req.headers.get("x-community-secret");
  return x ? x.trim() : null;
}

function serviceClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceKey) return null;
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function POST(req: Request) {
  const secret = process.env.COMMUNITY_POST_SECRET;
  if (!secret) {
    console.error("[community:post] COMMUNITY_POST_SECRET not configured");
    return Response.json({ error: "Not configured" }, { status: 500 });
  }
  const provided = readSecret(req);
  if (!provided || !constantTimeMatch(provided, secret)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = serviceClient();
  if (!supabase) {
    console.error("[community:post] Supabase env not configured");
    return Response.json({ error: "Not configured" }, { status: 500 });
  }

  const dry = new URL(req.url).searchParams.get("dry") != null;

  const nowMs = Date.now();
  const cutoffMs = Date.parse(COMMUNITY_START_POSTING_AFTER);
  const sinceIso = new Date(nowMs - COMMUNITY_LOOKBACK_HOURS * 3_600_000).toISOString();
  const untilIso = new Date(nowMs).toISOString();

  if (!dry) await markHeartbeatAttempt(supabase);

  try {
    const [maps, settings, matches] = await Promise.all([
      loadCommunityMaps(supabase),
      loadCommunitySettings(supabase),
      loadRecentlyFinishedMatches(supabase, sinceIso, untilIso),
    ]);
    const alreadyPosted = await loadAlreadyPosted(
      supabase,
      matches.map((m) => m.api_id),
    );

    const decisions = classifyCommunityMatches(matches, maps, {
      nowMs,
      cutoffMs,
      lookbackHours: COMMUNITY_LOOKBACK_HOURS,
      alreadyPosted,
    });
    const eligible = decisions.filter((d) => d.wouldPost);

    // Skip visibility (Guard #3): surface idle/misconfigured cities.
    const skipCounts: Record<string, number> = {};
    for (const d of decisions) {
      if (!d.wouldPost) skipCounts[d.reason] = (skipCounts[d.reason] ?? 0) + 1;
    }
    const idleCities = [
      ...new Set(
        decisions
          .filter((d) =>
            ["city_inactive", "city_no_url", "city_not_configured", "field_unassigned"].includes(
              d.reason,
            ),
          )
          .map((d) => d.cityCode ?? "?"),
      ),
    ];
    if (idleCities.length > 0) {
      console.log(`[community:post] idle/unconfigured cities in window: ${idleCities.join(", ")}`);
    }

    // ---------- DRY RUN — write nothing ----------
    if (dry) {
      return Response.json(
        {
          dryRun: true,
          postingEnabled: settings.posting_enabled,
          now: untilIso,
          cutoff: COMMUNITY_START_POSTING_AFTER,
          lookbackHours: COMMUNITY_LOOKBACK_HOURS,
          consideredMatches: decisions.length,
          wouldPostCount: eligible.length,
          wouldPost: eligible.map((d) => ({
            apiId: d.apiId,
            city: d.cityCode,
            communityId: d.communityId,
            community: d.communityName,
            displayName: d.displayName,
            endDateUtc: d.endDateUtc,
            messages: [d.copyText, d.urlText],
          })),
          skippedByReason: skipCounts,
        },
        { status: 200 },
      );
    }

    // ---------- Guard #4: global kill switch ----------
    if (!settings.posting_enabled) {
      console.log(
        `[community:post] posting DISABLED (kill switch). ${eligible.length} match(es) would have posted.`,
      );
      await markHeartbeatResult(supabase, true, 200);
      return Response.json(
        { ok: true, postingEnabled: false, posted: 0, wouldHavePosted: eligible.length },
        { status: 200 },
      );
    }

    // ---------- Real run ----------
    // Oldest-first so a catch-up drains fairly; cap per run (rest self-heals).
    const ordered = [...eligible].sort((a, b) =>
      (a.endDateUtc ?? "").localeCompare(b.endDateUtc ?? ""),
    );
    const batch = ordered.slice(0, MAX_POSTS_PER_RUN);
    const deferred = ordered.length - batch.length;
    if (deferred > 0) {
      console.log(`[community:post] capped at ${MAX_POSTS_PER_RUN}; ${deferred} deferred to next run`);
    }
    let posted = 0;
    let alreadyThere = 0;
    let failed = 0;
    for (const d of batch) {
      try {
        const res = await postCommunityInvite(supabase, {
          apiId: d.apiId,
          cityCode: d.cityCode!,
          displayName: d.displayName!,
          url: d.urlText!,
          communityId: d.communityId,
        });
        if (res.freshlyPosted) posted++;
        else alreadyThere++;
      } catch (err) {
        failed++;
        console.error(`[community:post] post failed match=${d.apiId}`, err);
      }
    }

    console.log(
      `[community:post] done posted=${posted} already=${alreadyThere} failed=${failed} skipped=${JSON.stringify(skipCounts)}`,
    );
    await markHeartbeatResult(supabase, true, 200);
    return Response.json(
      { ok: true, postingEnabled: true, posted, alreadyPosted: alreadyThere, failed, deferred, skippedByReason: skipCounts },
      { status: 200 },
    );
  } catch (err) {
    console.error("[community:post] run failed", err);
    if (!dry) {
      await markHeartbeatResult(
        supabase,
        false,
        500,
        err instanceof Error ? err.message : String(err),
      );
    }
    return Response.json({ error: "Run failed" }, { status: 500 });
  }
}

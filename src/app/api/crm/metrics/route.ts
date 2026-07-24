// GET /api/crm/metrics?period=week|month|all
//
// Support-performance tiles for the Chats page header strip:
//   1. Median first response  (business minutes, median not mean)
//   2. Answered within 1 hour (% of replied convos ≤ 60 business min)
//   3. Handled this period    (operator-touched convos + close rate)
//   4. Awaiting now           (LIVE — open threads the customer spoke
//                              last, oldest age + past-24h count)
//
// Tiles 1–3 are scoped to the selected period; tile 4 is always live and
// ignores the period. Week/month also carry a trend vs the previous
// period; all-time has no prior period so its trend is null.
//
// All computation is business-hours aware and lives in pure, tested libs
// (businessHours.ts, supportMetrics.ts). This route only fetches rows and
// hands them over — no metric math inline, so the numbers stay covered by
// unit tests rather than trusted to the request path.
//
// Auth: dual-mode bearer via authenticateCrm (admin OR can_access_chats).

import { authenticateCrm } from "@/lib/crmAuth";
import {
  computePeriodMetrics,
  computeAwaitingNow,
  computeTrend,
  resolvePeriodBounds,
  parsePeriodKind,
  type MetricMessage,
  type MetricThread,
  type AwaitingThread,
  type PeriodMetrics,
} from "@/lib/supportMetrics";
import { isAwaitingReply } from "@/lib/awaitingReply";

export const runtime = "nodejs";
export const maxDuration = 10;

const PAGE = 1000;

// All-time aggregates the full history; it "barely moves" (the spec's
// words) so a short in-memory TTL spares the page load a full-history
// scan on every mount / poll without risking staleness anyone would
// notice. Week/month are bounded and always computed live.
const ALL_TIME_TTL_MS = 60_000;
let allTimeCache: { at: number; body: unknown } | null = null;

type ThreadScanRow = {
  id: string;
  created_at: string;
  closed_at: string | null;
  status: "open" | "closed";
  last_message_at: string;
  last_message_direction: "inbound" | "outbound" | null;
};

type MessageScanRow = {
  thread_id: string;
  direction: "inbound" | "outbound";
  sent_at: string;
};

// PostgREST caps a select at 1000 rows; page through so counts stay
// correct as history grows. Ceiling bounds the worst case.
async function fetchAll<T>(
  runPage: (from: number, to: number) => Promise<{ data: T[] | null; error: unknown }>,
): Promise<{ rows: T[]; error: unknown }> {
  const rows: T[] = [];
  let from = 0;
  while (from < 200_000) {
    const { data, error } = await runPage(from, from + PAGE - 1);
    if (error) return { rows, error };
    const page = data ?? [];
    rows.push(...page);
    if (page.length < PAGE) break;
    from += PAGE;
  }
  return { rows, error: null };
}

export async function GET(req: Request) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }
  const { supabase } = auth;

  const url = new URL(req.url);
  const period = parsePeriodKind(url.searchParams.get("period"));

  if (period === "all" && allTimeCache && Date.now() - allTimeCache.at < ALL_TIME_TTL_MS) {
    return Response.json(allTimeCache.body, {
      status: 200,
      headers: { "x-cache": "hit" },
    });
  }

  const nowMs = Date.now();

  // Threads: the full set (small — the whole inbox history). Drives the
  // opened/closed/handled counts and the live awaiting tile.
  const threadRes = await fetchAll<ThreadScanRow>(async (from, to) => {
    const { data, error } = await supabase
      .from("crm_threads")
      .select("id, created_at, closed_at, status, last_message_at, last_message_direction")
      .order("created_at", { ascending: true })
      .range(from, to);
    return { data: data as ThreadScanRow[] | null, error };
  });
  if (threadRes.error) {
    console.error("[crm:metrics] thread scan error", threadRes.error);
    return Response.json({ error: "DB error" }, { status: 500 });
  }
  const threadRows = threadRes.rows;

  const threads: MetricThread[] = threadRows.map((t) => ({
    id: t.id,
    openedAtMs: Date.parse(t.created_at),
    closedAtMs: t.closed_at ? Date.parse(t.closed_at) : null,
    status: t.status,
  }));

  // Earliest opened-at anchors the all-time period start.
  const earliestMs = threads.reduce(
    (min, t) => (Number.isFinite(t.openedAtMs) && t.openedAtMs < min ? t.openedAtMs : min),
    nowMs,
  );

  const { current, previous } = resolvePeriodBounds(period, nowMs, earliestMs);

  // Messages: only those we could need — from the earliest boundary we
  // will look at (previous period start for week/month, earliest for
  // all-time) forward. Keeps the scan bounded as history grows while
  // still covering both the current and previous windows.
  const lowerBoundMs = previous ? previous.startMs : current.startMs;
  const lowerBoundIso = new Date(lowerBoundMs).toISOString();

  const msgRes = await fetchAll<MessageScanRow>(async (from, to) => {
    const { data, error } = await supabase
      .from("crm_messages")
      .select("thread_id, direction, sent_at")
      .gte("sent_at", lowerBoundIso)
      .order("sent_at", { ascending: true })
      .range(from, to);
    return { data: data as MessageScanRow[] | null, error };
  });
  if (msgRes.error) {
    console.error("[crm:metrics] message scan error", msgRes.error);
    return Response.json({ error: "DB error" }, { status: 500 });
  }
  const messages: MetricMessage[] = msgRes.rows.map((m) => ({
    threadId: m.thread_id,
    direction: m.direction,
    sentAtMs: Date.parse(m.sent_at),
  }));

  // Tiles 1–3, current period.
  const currentMetrics: PeriodMetrics = computePeriodMetrics(
    threads,
    messages,
    current,
  );

  // Trend vs previous (week/month only).
  const trend =
    previous != null
      ? computeTrend(
          currentMetrics,
          computePeriodMetrics(threads, messages, previous),
        )
      : null;

  // Tile 4 — live, from the current thread state (open + customer spoke
  // last). Uses last_message_at as the waiting-since instant.
  const awaitingThreads: AwaitingThread[] = threadRows
    .filter((t) =>
      isAwaitingReply({
        status: t.status,
        last_message_direction: t.last_message_direction,
      }),
    )
    .map((t) => ({ lastInboundAtMs: Date.parse(t.last_message_at) }));
  const awaiting = computeAwaitingNow(awaitingThreads, nowMs);

  const body = {
    period,
    generatedAt: new Date(nowMs).toISOString(),
    metrics: currentMetrics,
    trend,
    awaiting,
  };

  if (period === "all") {
    allTimeCache = { at: Date.now(), body };
  }

  return Response.json(body, { status: 200, headers: { "x-cache": "miss" } });
}

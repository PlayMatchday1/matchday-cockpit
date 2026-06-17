// GET /api/sms-log — data for the outbound-SMS dashboard. Admin-only.
//
// Reads the local telnyx_sms_log cache (migration 0063). Returns a
// filtered, paginated page of rows plus facet counts (source_type,
// city, delivery_status) and a small summary, so the dashboard can
// render filter chips without a second round-trip.
//
// Query params (all optional):
//   source_type  comma-separated list (e.g. "ops_broadcast,other")
//   city         exact recipient_city (normalized city slug)
//   status       exact delivery_status
//   q            free-text: matches recipient name, phone, or body (ilike)
//   since,until  ISO timestamps; filter on sent_at
//   limit        page size, default 100, clamped 1..500
//   offset       page offset, default 0
//
// Facets + summary are computed over the WHOLE table (bounded to ~90
// days by the cron's prune, ~3k rows), not the filtered page, so the
// chips always show the full breakdown. Phones are masked in the
// response (recipient name + city carry identification); the raw E.164
// stays server-side.
//
// Auth: admin session via authenticateCrm. RLS already restricts the
// table to authenticated, but the dashboard is admin-only PII, so we
// gate on auth.isAdmin too.

import { authenticateCrm } from "@/lib/crmAuth";
import { maskPhone } from "@/lib/matchNotify";

export const runtime = "nodejs";
export const maxDuration = 30;

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const FACET_CAP = 10000; // safety cap on the lightweight facet scan

const ROW_COLUMNS =
  "id, telnyx_message_id, to_phone, source_type, message_type, parts, " +
  "delivery_status, message_body, cost_amount, cost_currency, carrier, " +
  "errors, matched_user_id, recipient_first_name, recipient_last_name, " +
  "recipient_city, sent_at, completed_at, telnyx_created_at";

type FacetRow = {
  source_type: string | null;
  recipient_city: string | null;
  delivery_status: string | null;
  sent_at: string | null;
};

type SmsRow = {
  id: string;
  telnyx_message_id: string;
  to_phone: string;
  source_type: string;
  message_type: string | null;
  parts: number | null;
  delivery_status: string | null;
  message_body: string | null;
  cost_amount: number | null;
  cost_currency: string | null;
  carrier: string | null;
  errors: unknown;
  matched_user_id: number | null;
  recipient_first_name: string | null;
  recipient_last_name: string | null;
  recipient_city: string | null;
  sent_at: string | null;
  completed_at: string | null;
  telnyx_created_at: string | null;
};

function countBy(
  rows: FacetRow[],
  key: keyof FacetRow,
): Array<{ value: string; count: number }> {
  const m = new Map<string, number>();
  for (const r of rows) {
    const v = r[key];
    if (v == null || v === "") continue;
    m.set(String(v), (m.get(String(v)) ?? 0) + 1);
  }
  return [...m.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count);
}

export async function GET(req: Request) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }
  if (!auth.isAdmin) {
    return Response.json({ error: "Admin access required" }, { status: 403 });
  }
  const { supabase } = auth;

  const url = new URL(req.url);
  const sourceTypes = (url.searchParams.get("source_type") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const city = url.searchParams.get("city")?.trim() || null;
  const status = url.searchParams.get("status")?.trim() || null;
  const q = url.searchParams.get("q")?.trim() || null;
  const since = url.searchParams.get("since")?.trim() || null;
  const until = url.searchParams.get("until")?.trim() || null;

  const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(MAX_LIMIT, Math.max(1, rawLimit))
    : DEFAULT_LIMIT;
  const rawOffset = Number.parseInt(url.searchParams.get("offset") ?? "", 10);
  const offset = Number.isFinite(rawOffset) ? Math.max(0, rawOffset) : 0;

  // --- Facets + summary over the whole table (lightweight columns). ---
  const facetRes = await supabase
    .from("telnyx_sms_log")
    .select("source_type, recipient_city, delivery_status, sent_at")
    .order("sent_at", { ascending: false })
    .limit(FACET_CAP);
  if (facetRes.error) {
    console.error("[sms-log] facet query failed", facetRes.error);
    return Response.json({ error: "DB error" }, { status: 500 });
  }
  const facetRows = (facetRes.data ?? []) as FacetRow[];
  const sentTimes = facetRows
    .map((r) => r.sent_at)
    .filter((t): t is string => typeof t === "string");

  // --- Filtered, paginated page. ---
  let query = supabase
    .from("telnyx_sms_log")
    .select(ROW_COLUMNS, { count: "exact" })
    .order("sent_at", { ascending: false, nullsFirst: false });

  if (sourceTypes.length > 0) query = query.in("source_type", sourceTypes);
  if (city) query = query.eq("recipient_city", city);
  if (status) query = query.eq("delivery_status", status);
  if (since) query = query.gte("sent_at", since);
  if (until) query = query.lte("sent_at", until);
  if (q) {
    // Inside an or() string PostgREST uses `*` as the ilike wildcard
    // (not `%`). Strip the chars that delimit the or() grammar so the
    // user term can't break the filter.
    const safe = q.replace(/[,()*]/g, " ");
    query = query.or(
      [
        `recipient_first_name.ilike.*${safe}*`,
        `recipient_last_name.ilike.*${safe}*`,
        `to_phone.ilike.*${safe}*`,
        `message_body.ilike.*${safe}*`,
      ].join(","),
    );
  }

  const rowsRes = await query.range(offset, offset + limit - 1);
  if (rowsRes.error) {
    console.error("[sms-log] rows query failed", rowsRes.error);
    return Response.json({ error: "DB error" }, { status: 500 });
  }
  const rows = (rowsRes.data ?? []) as unknown as SmsRow[];

  return Response.json(
    {
      rows: rows.map((r) => ({
        id: r.id,
        telnyx_message_id: r.telnyx_message_id,
        masked_phone: maskPhone(r.to_phone),
        source_type: r.source_type,
        message_type: r.message_type,
        parts: r.parts,
        delivery_status: r.delivery_status,
        message_body: r.message_body,
        cost_amount: r.cost_amount,
        cost_currency: r.cost_currency,
        carrier: r.carrier,
        has_errors: Array.isArray(r.errors) && r.errors.length > 0,
        matched_user_id: r.matched_user_id,
        recipient_first_name: r.recipient_first_name,
        recipient_last_name: r.recipient_last_name,
        recipient_city: r.recipient_city,
        sent_at: r.sent_at,
        completed_at: r.completed_at,
        telnyx_created_at: r.telnyx_created_at,
      })),
      page: { limit, offset, total: rowsRes.count ?? null },
      facets: {
        source_types: countBy(facetRows, "source_type"),
        cities: countBy(facetRows, "recipient_city"),
        statuses: countBy(facetRows, "delivery_status"),
      },
      summary: {
        total_in_table: facetRows.length,
        capped: facetRows.length >= FACET_CAP,
        oldest_sent_at: sentTimes.length ? sentTimes[sentTimes.length - 1] : null,
        newest_sent_at: sentTimes.length ? sentTimes[0] : null,
      },
    },
    { status: 200 },
  );
}

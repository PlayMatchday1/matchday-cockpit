"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

// Client UI for the SMS Log dashboard. Fetches GET /api/sms-log
// (admin-only) with source-type / city / status / text filters and
// offset pagination, and exposes the on-demand "fetch recent" trigger
// (POST /api/sms-log/ingest) so an operator can pull today's sends
// without waiting for the daily cron.

const PAGE_SIZE = 100;

// Human labels for the source_type slugs the ingest writes. Unknown
// slugs fall back to the raw value.
const SOURCE_LABELS: Record<string, string> = {
  match_notify: "Match notify",
  player_match_reminder: "Player reminder",
  manager_match_reminder: "Manager reminder",
  match_cancellation: "Cancellation",
  welcome_intro: "Welcome / intro",
  ops_broadcast: "Ops broadcast",
  booking_confirmation: "Booking confirm",
  other: "Other",
};

function sourceLabel(slug: string): string {
  return SOURCE_LABELS[slug] ?? slug;
}

type Facet = { value: string; count: number };

type SmsRow = {
  id: string;
  telnyx_message_id: string;
  masked_phone: string;
  source_type: string;
  message_type: string | null;
  parts: number | null;
  delivery_status: string | null;
  message_body: string | null;
  cost_amount: number | null;
  cost_currency: string | null;
  carrier: string | null;
  has_errors: boolean;
  matched_user_id: number | null;
  recipient_first_name: string | null;
  recipient_last_name: string | null;
  recipient_city: string | null;
  sent_at: string | null;
  completed_at: string | null;
  telnyx_created_at: string | null;
};

type ApiResponse = {
  rows: SmsRow[];
  page: { limit: number; offset: number; total: number | null };
  facets: {
    source_types: Facet[];
    cities: Facet[];
    statuses: Facet[];
  };
  summary: {
    total_in_table: number;
    capped: boolean;
    oldest_sent_at: string | null;
    newest_sent_at: string | null;
  };
};

async function bearerHeaders(): Promise<Record<string, string> | null> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return null;
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function recipientName(r: SmsRow): string {
  const first = (r.recipient_first_name ?? "").trim();
  const last = (r.recipient_last_name ?? "").trim();
  const full = `${first} ${last}`.trim();
  return full || "Unknown";
}

export default function SmsLogView() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters.
  const [activeSources, setActiveSources] = useState<string[]>([]);
  const [city, setCity] = useState<string>("");
  const [status, setStatus] = useState<string>("");
  const [q, setQ] = useState<string>("");
  const [qInput, setQInput] = useState<string>("");
  const [offset, setOffset] = useState(0);

  // Ingest trigger state.
  const [ingesting, setIngesting] = useState(false);
  const [ingestMsg, setIngestMsg] = useState<string | null>(null);

  // Expanded message bodies.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const headers = await bearerHeaders();
    if (!headers) {
      setError("Not signed in");
      setLoading(false);
      return;
    }
    const params = new URLSearchParams();
    if (activeSources.length > 0) params.set("source_type", activeSources.join(","));
    if (city) params.set("city", city);
    if (status) params.set("status", status);
    if (q) params.set("q", q);
    params.set("limit", String(PAGE_SIZE));
    params.set("offset", String(offset));
    try {
      const res = await fetch(`/api/sms-log?${params.toString()}`, { headers });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `Request failed (${res.status})`);
        setData(null);
      } else {
        setData((await res.json()) as ApiResponse);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [activeSources, city, status, q, offset]);

  useEffect(() => {
    void load();
  }, [load]);

  function toggleSource(value: string) {
    setOffset(0);
    setActiveSources((prev) =>
      prev.includes(value) ? prev.filter((s) => s !== value) : [...prev, value],
    );
  }

  function applySearch() {
    setOffset(0);
    setQ(qInput.trim());
  }

  function clearFilters() {
    setActiveSources([]);
    setCity("");
    setStatus("");
    setQ("");
    setQInput("");
    setOffset(0);
  }

  async function fetchRecent() {
    setIngesting(true);
    setIngestMsg(null);
    const headers = await bearerHeaders();
    if (!headers) {
      setIngestMsg("Not signed in");
      setIngesting(false);
      return;
    }
    try {
      const res = await fetch("/api/sms-log/ingest?hours=24", {
        method: "POST",
        headers,
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        rowsUpserted?: number;
        outboundSeen?: number;
      };
      if (!res.ok) {
        setIngestMsg(body.error ?? `Ingest failed (${res.status})`);
      } else {
        setIngestMsg(
          `Pulled ${body.outboundSeen ?? 0} outbound, stored ${body.rowsUpserted ?? 0}.`,
        );
        setOffset(0);
        await load();
      }
    } catch (e) {
      setIngestMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setIngesting(false);
    }
  }

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const total = data?.page.total ?? null;
  const showingFrom = data && data.rows.length > 0 ? offset + 1 : 0;
  const showingTo = data ? offset + data.rows.length : 0;
  const hasFilters =
    activeSources.length > 0 || !!city || !!status || !!q;

  return (
    <div className="space-y-4">
      {/* Toolbar: search + fetch-recent + summary. */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <input
            type="search"
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") applySearch();
            }}
            placeholder="Search name, phone, or body"
            className="w-64 rounded-md border border-cream-line bg-white px-3 py-1.5 text-sm text-deep-green placeholder:text-deep-green/40 focus:border-mint focus:outline-none"
          />
          <button
            type="button"
            onClick={applySearch}
            className="rounded-md bg-deep-green px-3 py-1.5 text-sm font-medium text-cream transition hover:bg-deep-green-soft"
          >
            Search
          </button>
        </div>
        {hasFilters && (
          <button
            type="button"
            onClick={clearFilters}
            className="text-sm text-deep-green/70 underline transition hover:text-deep-green"
          >
            Clear filters
          </button>
        )}
        <div className="ml-auto flex items-center gap-3">
          {ingestMsg && (
            <span className="text-xs text-deep-green/70">{ingestMsg}</span>
          )}
          <button
            type="button"
            onClick={fetchRecent}
            disabled={ingesting}
            className="rounded-md border border-mint bg-mint-soft px-3 py-1.5 text-sm font-medium text-deep-green transition hover:bg-mint disabled:opacity-50"
          >
            {ingesting ? "Fetching…" : "Fetch recent (24h)"}
          </button>
        </div>
      </div>

      {/* Summary line. */}
      {data && (
        <p className="text-xs text-deep-green/60">
          {data.summary.total_in_table.toLocaleString()} messages cached
          {data.summary.oldest_sent_at && data.summary.newest_sent_at && (
            <>
              {" "}
              · {fmtTime(data.summary.oldest_sent_at)} –{" "}
              {fmtTime(data.summary.newest_sent_at)}
            </>
          )}
          {data.summary.capped && " · facet view capped"}
        </p>
      )}

      {/* Source-type filter chips. */}
      {data && data.facets.source_types.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {data.facets.source_types.map((f) => {
            const on = activeSources.includes(f.value);
            return (
              <button
                key={f.value}
                type="button"
                onClick={() => toggleSource(f.value)}
                className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
                  on
                    ? "border-mint bg-mint text-deep-green"
                    : "border-cream-line bg-white text-deep-green/80 hover:bg-cream-soft"
                }`}
              >
                {sourceLabel(f.value)}{" "}
                <span className="opacity-60">{f.count}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* City + status selects. */}
      {data && (
        <div className="flex flex-wrap gap-3">
          {data.facets.cities.length > 0 && (
            <select
              value={city}
              onChange={(e) => {
                setOffset(0);
                setCity(e.target.value);
              }}
              className="rounded-md border border-cream-line bg-white px-3 py-1.5 text-sm text-deep-green focus:border-mint focus:outline-none"
            >
              <option value="">All cities</option>
              {data.facets.cities.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.value} ({f.count})
                </option>
              ))}
            </select>
          )}
          {data.facets.statuses.length > 0 && (
            <select
              value={status}
              onChange={(e) => {
                setOffset(0);
                setStatus(e.target.value);
              }}
              className="rounded-md border border-cream-line bg-white px-3 py-1.5 text-sm text-deep-green focus:border-mint focus:outline-none"
            >
              <option value="">All statuses</option>
              {data.facets.statuses.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.value} ({f.count})
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Rows. */}
      <div className="overflow-hidden rounded-lg border border-cream-line bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-cream-line bg-cream-soft text-left text-xs uppercase tracking-wide text-deep-green/60">
              <th className="px-3 py-2 font-semibold">Sent</th>
              <th className="px-3 py-2 font-semibold">Recipient</th>
              <th className="px-3 py-2 font-semibold">Type</th>
              <th className="px-3 py-2 font-semibold">Status</th>
              <th className="px-3 py-2 font-semibold">Message</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-deep-green/50">
                  Loading…
                </td>
              </tr>
            )}
            {!loading && data && data.rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-deep-green/50">
                  No messages match these filters.
                </td>
              </tr>
            )}
            {!loading &&
              data?.rows.map((r) => {
                const isOpen = expanded.has(r.id);
                const body = r.message_body ?? "";
                const long = body.length > 90;
                return (
                  <tr
                    key={r.id}
                    className="border-b border-cream-line/60 align-top last:border-0"
                  >
                    <td className="whitespace-nowrap px-3 py-2 text-deep-green/70">
                      {fmtTime(r.sent_at)}
                    </td>
                    <td className="px-3 py-2">
                      <div className="font-medium text-deep-green">
                        {recipientName(r)}
                      </div>
                      <div className="text-xs text-deep-green/50">
                        {r.masked_phone}
                        {r.recipient_city ? ` · ${r.recipient_city}` : ""}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      <span className="rounded-full bg-cream-soft px-2 py-0.5 text-xs font-medium text-deep-green/80">
                        {sourceLabel(r.source_type)}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-deep-green/70">
                      {r.delivery_status ?? "—"}
                      {r.has_errors && (
                        <span className="ml-1 text-red-600" title="Delivery errors">
                          ⚠
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-deep-green/80">
                      <span>
                        {long && !isOpen ? `${body.slice(0, 90)}…` : body || "—"}
                      </span>
                      {long && (
                        <button
                          type="button"
                          onClick={() => toggleExpand(r.id)}
                          className="ml-1 text-xs text-deep-green/50 underline"
                        >
                          {isOpen ? "less" : "more"}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>

      {/* Pagination. */}
      <div className="flex items-center justify-between text-sm text-deep-green/70">
        <span>
          {showingFrom}–{showingTo}
          {total != null ? ` of ${total.toLocaleString()}` : ""}
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={offset === 0 || loading}
            onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
            className="rounded-md border border-cream-line px-3 py-1 transition hover:bg-cream-soft disabled:opacity-40"
          >
            Previous
          </button>
          <button
            type="button"
            disabled={
              loading ||
              (total != null
                ? offset + PAGE_SIZE >= total
                : (data?.rows.length ?? 0) < PAGE_SIZE)
            }
            onClick={() => setOffset((o) => o + PAGE_SIZE)}
            className="rounded-md border border-cream-line px-3 py-1 transition hover:bg-cream-soft disabled:opacity-40"
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}

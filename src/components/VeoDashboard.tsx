"use client";

// Admin surface for the Veo auto-poster. Two sections:
//   • Needs review — queued items (unparsed / unknown code / unconfirmed /
//     no match / multiple matches / post failed). Each has one-click assign
//     to a candidate (or a manual match id) and a dismiss.
//   • Recent activity — auto-posts and dismissals, so misses are visible.
//
// Reads the enriched list from GET /api/veo (admin-gated) and mutates via
// POST/DELETE /api/veo/[id] with the session bearer token — same pattern as
// InventoryDashboard.

import { useCallback, useEffect, useMemo, useState } from "react";
import { ExternalLink, RefreshCw, RotateCw } from "lucide-react";
import { supabase } from "@/lib/supabase";
import VeoCodesEditor from "@/components/VeoCodesEditor";

type VeoRow = {
  id: string;
  recording_id: string;
  match_path_slug: string | null;
  video_url: string;
  email_subject: string;
  email_from: string | null;
  received_at: string | null;
  parsed_code: string | null;
  parsed_match_date: string | null;
  parsed_time_label: string | null;
  status: string;
  queue_reason: string | null;
  matched_api_id: number | null;
  candidate_api_ids: number[] | null;
  posted_at: string | null;
  created_at: string;
};

type CodeStat = {
  code: string;
  label: string;
  city: string;
  confirmed: boolean;
  posted: number;
  queued: number;
};

type ListPayload = {
  queue: VeoRow[];
  recent: VeoRow[];
  labels: Record<number, string>;
  codeStats: CodeStat[];
};

const REASON_META: Record<string, { label: string; tone: "coral" | "amber" | "blue" }> = {
  unparseable_subject: { label: "Couldn't read title", tone: "coral" },
  unknown_code: { label: "Unknown code", tone: "coral" },
  unconfirmed_code: { label: "Code not confirmed", tone: "amber" },
  no_match: { label: "No scheduled match", tone: "amber" },
  multiple_matches: { label: "Multiple matches", tone: "amber" },
  field_mismatch: { label: "Field disagrees with code", tone: "amber" },
  ambiguous_time: { label: "Ambiguous time (am/pm)", tone: "amber" },
  post_failed: { label: "Post failed — retry", tone: "coral" },
};

function reasonPill(reason: string | null) {
  const meta = reason ? REASON_META[reason] : undefined;
  const label = meta?.label ?? reason ?? "Queued";
  const cls =
    meta?.tone === "coral"
      ? "border-coral/40 bg-coral-soft text-coral-hover"
      : meta?.tone === "blue"
        ? "border-blue-info/40 bg-blue-soft text-blue-hover"
        : "border-amber-300 bg-amber-50 text-amber-700";
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${cls}`}>
      {label}
    </span>
  );
}

async function bearerHeaders(): Promise<Record<string, string> | null> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return null;
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

function fmtWhen(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function VeoDashboard() {
  const [data, setData] = useState<ListPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [manualId, setManualId] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setError(null);
    const headers = await bearerHeaders();
    if (!headers) {
      setError("Not signed in.");
      setLoading(false);
      return;
    }
    try {
      const res = await fetch("/api/veo", { headers });
      const json = (await res.json()) as ListPayload & { error?: string };
      if (!res.ok) {
        setError(json.error ?? "Failed to load.");
      } else {
        setData({
          queue: json.queue,
          recent: json.recent,
          labels: json.labels,
          codeStats: json.codeStats ?? [],
        });
      }
    } catch {
      setError("Network error.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const assign = useCallback(
    async (id: string, apiId: number) => {
      setBusyId(id);
      setError(null);
      try {
        const headers = await bearerHeaders();
        if (!headers) {
          setError("Not signed in.");
          return;
        }
        const res = await fetch(`/api/veo/${id}`, {
          method: "POST",
          headers,
          body: JSON.stringify({ apiId }),
        });
        const json = (await res.json()) as { error?: string };
        if (!res.ok) {
          setError(json.error ?? "Assign failed.");
          return;
        }
        await load();
      } catch {
        setError("Network error.");
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  const dismiss = useCallback(
    async (id: string) => {
      setBusyId(id);
      setError(null);
      try {
        const headers = await bearerHeaders();
        if (!headers) {
          setError("Not signed in.");
          return;
        }
        const res = await fetch(`/api/veo/${id}`, { method: "DELETE", headers });
        const json = (await res.json()) as { error?: string };
        if (!res.ok) {
          setError(json.error ?? "Dismiss failed.");
          return;
        }
        await load();
      } catch {
        setError("Network error.");
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  const labels = data?.labels ?? {};
  const queue = data?.queue ?? [];
  const recent = data?.recent ?? [];
  const codeStats = data?.codeStats ?? [];

  const postedCount = useMemo(
    () => recent.filter((r) => r.status === "posted").length,
    [recent],
  );

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div className="text-sm text-deep-green/70">
          {loading
            ? "Loading…"
            : `${queue.length} in review · ${postedCount} recent auto-post${postedCount === 1 ? "" : "s"}`}
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-cream-line bg-white px-3 py-1.5 text-[13px] font-semibold text-deep-green transition hover:border-mint"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-coral/40 bg-coral-soft px-3 py-2 text-sm text-coral-hover">
          {error}
        </div>
      )}

      {/* ------------------- Codes & per-code readiness ------------------- */}
      <VeoCodesEditor stats={codeStats} onChanged={() => void load()} />

      {/* ------------------------- Review queue ------------------------- */}
      <section>
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-deep-green/60">
          Needs review
        </h2>
        {queue.length === 0 && !loading ? (
          <div className="rounded-xl border border-dashed border-cream-line bg-cream-soft px-4 py-8 text-center text-sm text-deep-green/50">
            Nothing waiting. Confidently matched recordings post automatically.
          </div>
        ) : (
          <ul className="space-y-3">
            {queue.map((r) => {
              // post_failed is NOT a matching decision — the recording matched
              // a scheduled match, the post to the thread just failed. Render
              // it distinctly as a one-click retry (coral card + Retry button),
              // separate from matching-ambiguity items that need an operator
              // decision. The matched match is candidate_api_ids[0].
              const isPostFailed = r.queue_reason === "post_failed";
              const retryTarget =
                r.candidate_api_ids && r.candidate_api_ids.length > 0
                  ? r.candidate_api_ids[0]
                  : null;
              return (
                <li
                  key={r.id}
                  className={
                    isPostFailed
                      ? "rounded-xl border-2 border-coral/50 bg-coral-soft/40 p-4"
                      : "rounded-xl border border-cream-line bg-white p-4"
                  }
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        {isPostFailed ? (
                          <span className="inline-flex items-center gap-1 rounded-full border border-coral/60 bg-white px-2 py-0.5 text-[11px] font-bold text-coral-hover">
                            <RotateCw className="h-3 w-3" />
                            Matched — post failed
                          </span>
                        ) : (
                          reasonPill(r.queue_reason)
                        )}
                        {r.parsed_code && (
                          <span className="font-mono text-[13px] font-bold text-deep-green">
                            {r.parsed_code}
                          </span>
                        )}
                        <span className="text-[13px] text-deep-green/70">
                          {r.parsed_match_date ?? "date ?"}
                          {r.parsed_time_label ? ` · ${r.parsed_time_label}` : ""}
                        </span>
                      </div>
                      {isPostFailed && (
                        <div className="mt-1 text-xs font-medium text-coral-hover">
                          Matched a scheduled match — posting the film failed. One-click retry;
                          it won&apos;t double-post.
                        </div>
                      )}
                      <div className="mt-1 truncate text-xs text-deep-green/50">
                        {r.email_subject}
                      </div>
                      <a
                        href={r.video_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-1 inline-flex items-center gap-1 text-[13px] font-medium text-mint-hover hover:underline"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                        Open Veo link
                      </a>
                    </div>
                    <button
                      type="button"
                      disabled={busyId === r.id}
                      onClick={() => void dismiss(r.id)}
                      className="rounded-lg border border-cream-line px-2.5 py-1 text-xs font-medium text-deep-green/60 transition hover:border-coral/50 hover:bg-coral-soft hover:text-coral-hover disabled:opacity-50"
                    >
                      Dismiss
                    </button>
                  </div>

                  {isPostFailed && retryTarget != null ? (
                    /* One-click retry — assign to the already-matched match. */
                    <div className="mt-3 border-t border-coral/20 pt-3">
                      <button
                        type="button"
                        disabled={busyId === r.id}
                        onClick={() => void assign(r.id, retryTarget)}
                        className="flex w-full items-center justify-between gap-2 rounded-lg bg-deep-green px-3 py-2.5 text-left text-[13px] font-semibold text-white transition hover:bg-deep-green-hover disabled:opacity-50"
                      >
                        <span className="truncate">
                          Retry post → {labels[retryTarget] ?? `Match ${retryTarget}`}
                        </span>
                        <RotateCw className="h-4 w-4 shrink-0" />
                      </button>
                    </div>
                  ) : (
                    /* Matching decision — pick which match this recording belongs to. */
                    <div className="mt-3 border-t border-cream-line pt-3">
                      {r.candidate_api_ids && r.candidate_api_ids.length > 0 ? (
                        <div className="space-y-1.5">
                          <div className="text-[11px] font-semibold uppercase tracking-wide text-deep-green/45">
                            Assign to match
                          </div>
                          {r.candidate_api_ids.map((apiId) => (
                            <button
                              key={apiId}
                              type="button"
                              disabled={busyId === r.id}
                              onClick={() => void assign(r.id, apiId)}
                              className="flex w-full items-center justify-between gap-2 rounded-lg border border-cream-line bg-cream-soft px-3 py-2 text-left text-[13px] text-deep-green transition hover:border-mint hover:bg-mint-soft disabled:opacity-50"
                            >
                              <span className="truncate">
                                {labels[apiId] ?? `Match ${apiId}`}
                              </span>
                              <span className="shrink-0 font-semibold text-mint-hover">
                                Post →
                              </span>
                            </button>
                          ))}
                        </div>
                      ) : (
                        <div className="text-[11px] font-semibold uppercase tracking-wide text-deep-green/45">
                          No candidate — assign by match id
                        </div>
                      )}
                      <div className="mt-2 flex items-center gap-2">
                        <input
                          inputMode="numeric"
                          placeholder="match id (api_id)"
                          value={manualId[r.id] ?? ""}
                          onChange={(e) =>
                            setManualId((m) => ({ ...m, [r.id]: e.target.value }))
                          }
                          className="w-44 rounded-lg border border-cream-line bg-white px-2.5 py-1.5 text-[13px] text-deep-green outline-none focus:border-mint"
                        />
                        <button
                          type="button"
                          disabled={busyId === r.id || !manualId[r.id]?.trim()}
                          onClick={() => {
                            const n = Number(manualId[r.id]);
                            if (Number.isInteger(n) && n > 0) void assign(r.id, n);
                          }}
                          className="rounded-lg bg-deep-green px-3 py-1.5 text-[13px] font-semibold text-white transition hover:bg-deep-green-hover disabled:opacity-50"
                        >
                          Assign
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ------------------------- Recent activity ------------------------- */}
      <section>
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-deep-green/60">
          Recent activity
        </h2>
        {recent.length === 0 && !loading ? (
          <div className="rounded-xl border border-dashed border-cream-line bg-cream-soft px-4 py-8 text-center text-sm text-deep-green/50">
            No auto-posts yet.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-cream-line">
            <table className="w-full min-w-[640px] text-left text-[13px]">
              <thead className="bg-cream-soft text-[11px] uppercase tracking-wide text-deep-green/50">
                <tr>
                  <th className="px-3 py-2 font-semibold">Status</th>
                  <th className="px-3 py-2 font-semibold">Match</th>
                  <th className="px-3 py-2 font-semibold">Title</th>
                  <th className="px-3 py-2 font-semibold">Link</th>
                  <th className="px-3 py-2 font-semibold">When</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-cream-line">
                {recent.map((r) => (
                  <tr key={r.id} className="bg-white">
                    <td className="px-3 py-2">
                      {r.status === "posted" ? (
                        <span className="inline-flex items-center rounded-full border border-mint/50 bg-mint-soft px-2 py-0.5 text-[11px] font-semibold text-deep-green">
                          Posted
                        </span>
                      ) : (
                        <span className="inline-flex items-center rounded-full border border-cream-line bg-cream-soft px-2 py-0.5 text-[11px] font-semibold text-deep-green/50">
                          Dismissed
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-deep-green/80">
                      {r.matched_api_id ? labels[r.matched_api_id] ?? `Match ${r.matched_api_id}` : "—"}
                    </td>
                    <td className="px-3 py-2 text-deep-green/60">
                      {r.parsed_code ? (
                        <span className="font-mono font-semibold text-deep-green">{r.parsed_code}</span>
                      ) : null}
                      {r.parsed_match_date ? ` · ${r.parsed_match_date}` : ""}
                      {r.parsed_time_label ? ` ${r.parsed_time_label}` : ""}
                    </td>
                    <td className="px-3 py-2">
                      <a
                        href={r.video_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 font-medium text-mint-hover hover:underline"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                        Veo
                      </a>
                    </td>
                    <td className="px-3 py-2 text-deep-green/50">
                      {fmtWhen(r.posted_at ?? r.created_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

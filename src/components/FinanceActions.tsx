"use client";

// Shared Finance Actions section. Renders pinned to the top of the
// viewport (below the FinanceTabNav) on Cities, Field Ranking, Match
// P&L, and Slate Review. ONE global list across all users.
//
// Sticky behavior: the header + filter pills + add-action row are
// pinned at top-14 z-30 so the operator can add or filter actions
// from anywhere on the tab without scrolling back up. The list of
// existing actions lives inside the same sticky element but is only
// rendered when expanded (default: collapsed), so the slim sticky
// bar doesn't eat vertical space during normal scrolling. When
// expanded the list scrolls internally (max-h 60vh) rather than
// pushing the sticky bar's bottom off the viewport.
//
// The city filter on this section is intentionally independent of
// the page's city pills — you can filter Actions to "Dallas" while
// viewing the Match P&L tab without binding the two together.
//
// Storage: finance_actions + finance_action_comments (migration
// 0050). RLS: authenticated read+write.

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/useAuth";
import { CITIES } from "@/lib/types";

const COMPANY_WIDE = "Company-wide" as const;

// 8 cities + Company-wide, in the same order that pills appear
// elsewhere — Company-wide listed first so non-city items don't get
// buried at the end.
const CITY_OPTIONS = [COMPANY_WIDE, ...CITIES] as const;
type CityValue = (typeof CITY_OPTIONS)[number];

type StatusValue = "open" | "needs_follow_up" | "blocked" | "resolved";

const STATUS_LABEL: Record<StatusValue, string> = {
  open: "Open",
  needs_follow_up: "Needs follow-up",
  blocked: "Blocked",
  resolved: "Resolved",
};

// Status pill colors borrowed from the Match P&L status pills so the
// Finance section feels coherent. Open is the neutral pill; blocked
// is coral; needs_follow_up is the amber breakeven tone; resolved is
// the profit mint.
const STATUS_PILL: Record<StatusValue, string> = {
  open: "bg-cream-soft text-deep-green/80",
  needs_follow_up: "bg-[rgba(245,158,11,0.15)] text-[#92400E]",
  blocked: "bg-coral-soft text-coral",
  resolved: "bg-mint-soft text-deep-green",
};

// Sort key per status: active first (open → needs_follow_up →
// blocked), resolved at the bottom. Ties broken by created_at desc.
const STATUS_RANK: Record<StatusValue, number> = {
  open: 0,
  needs_follow_up: 1,
  blocked: 2,
  resolved: 3,
};

type Action = {
  id: string;
  body: string;
  status: StatusValue;
  city: string;
  created_by: string;
  created_at: string;
  updated_at: string;
};

type Comment = {
  id: string;
  action_id: string;
  body: string;
  created_by: string;
  created_at: string;
};

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const month = d.toLocaleString("en-US", { month: "short" });
  const day = d.getDate();
  const time = d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
  return sameYear
    ? `${month} ${day} · ${time}`
    : `${month} ${day}, ${d.getFullYear()} · ${time}`;
}

function isCityValue(v: string): v is CityValue {
  return (CITY_OPTIONS as readonly string[]).includes(v);
}

export default function FinanceActions() {
  const { appUser } = useAuth();
  const callerEmail = appUser?.email ?? null;

  const [actions, setActions] = useState<Action[]>([]);
  const [commentsByAction, setCommentsByAction] = useState<
    Record<string, Comment[]>
  >({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Add-action form state.
  const [draftBody, setDraftBody] = useState("");
  const [draftCity, setDraftCity] = useState<CityValue>(COMPANY_WIDE);
  const [adding, setAdding] = useState(false);

  // Filter — defaults to "All". Independent of page-level city pills.
  const [filterCity, setFilterCity] = useState<"All" | CityValue>("All");

  // List expansion — default collapsed so the sticky bar stays slim.
  // Toggling shows/hides the action list inside the sticky element.
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [actionsRes, commentsRes] = await Promise.all([
      supabase
        .from("finance_actions")
        .select("*")
        .order("created_at", { ascending: false }),
      supabase
        .from("finance_action_comments")
        .select("*")
        .order("created_at", { ascending: true }),
    ]);
    if (actionsRes.error) {
      setError(actionsRes.error.message);
      setLoading(false);
      return;
    }
    if (commentsRes.error) {
      setError(commentsRes.error.message);
      setLoading(false);
      return;
    }
    setActions((actionsRes.data ?? []) as Action[]);
    const grouped: Record<string, Comment[]> = {};
    for (const c of (commentsRes.data ?? []) as Comment[]) {
      (grouped[c.action_id] ??= []).push(c);
    }
    setCommentsByAction(grouped);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function addAction() {
    const body = draftBody.trim();
    if (!body) return;
    if (!callerEmail) {
      setError("Not signed in.");
      return;
    }
    setAdding(true);
    setError(null);
    const { error: err } = await supabase.from("finance_actions").insert({
      body,
      status: "open",
      city: draftCity,
      created_by: callerEmail,
    });
    setAdding(false);
    if (err) {
      setError(err.message);
      return;
    }
    setDraftBody("");
    setDraftCity(COMPANY_WIDE);
    void load();
  }

  async function updateAction(id: string, patch: Partial<Action>) {
    const { error: err } = await supabase
      .from("finance_actions")
      .update(patch)
      .eq("id", id);
    if (err) {
      setError(err.message);
      return;
    }
    void load();
  }

  async function deleteAction(id: string) {
    if (!confirm("Delete this action and its comments?")) return;
    const { error: err } = await supabase
      .from("finance_actions")
      .delete()
      .eq("id", id);
    if (err) {
      setError(err.message);
      return;
    }
    void load();
  }

  async function addComment(actionId: string, body: string) {
    if (!callerEmail) {
      setError("Not signed in.");
      return;
    }
    const trimmed = body.trim();
    if (!trimmed) return;
    const { error: err } = await supabase
      .from("finance_action_comments")
      .insert({ action_id: actionId, body: trimmed, created_by: callerEmail });
    if (err) {
      setError(err.message);
      return;
    }
    void load();
  }

  const filtered = useMemo(() => {
    const base =
      filterCity === "All"
        ? actions
        : actions.filter((a) => a.city === filterCity);
    return [...base].sort((a, b) => {
      const rank = STATUS_RANK[a.status] - STATUS_RANK[b.status];
      if (rank !== 0) return rank;
      return b.created_at.localeCompare(a.created_at);
    });
  }, [actions, filterCity]);

  const openCount = useMemo(
    () => actions.filter((a) => a.status !== "resolved").length,
    [actions],
  );

  return (
    // Sticky bar: pinned at top-14 (below FinanceTabNav which sits at
    // top-0). z-30 matches the tab nav and beats SlateReviewCityPills
    // (z-20) so the Slate Review city selector cleanly slides under
    // this bar when both want to occupy top-14 simultaneously.
    //
    // Solid cream-soft background + backdrop-blur so scrolled-under
    // content doesn't bleed through. Edge-to-edge via -mx-4/sm:-mx-6
    // matching the SlateReviewCityPills + FinanceTabNav pattern.
    <div className="sticky top-14 z-30 -mx-4 mt-4 border-y border-cream-line bg-cream-soft/95 backdrop-blur supports-[backdrop-filter]:bg-cream-soft/80 sm:-mx-6">
      <div className="space-y-2 px-4 py-3 sm:px-6">
        {/* Header row: chevron toggle + title + active/total count */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            className="flex items-center gap-2 rounded-md text-left transition hover:opacity-75"
          >
            {expanded ? (
              <ChevronDown
                size={18}
                aria-hidden
                className="text-deep-green/55"
              />
            ) : (
              <ChevronRight
                size={18}
                aria-hidden
                className="text-deep-green/55"
              />
            )}
            <span className="text-base font-bold tracking-tight text-deep-green sm:text-lg">
              Actions
            </span>
          </button>
          <span className="text-[11px] font-normal text-deep-green/55">
            <span className="font-bold tabular-nums text-deep-green">
              {openCount}
            </span>{" "}
            active · {actions.length} total
          </span>
        </div>

        {/* Filter pills — independent of the page's city selection */}
        <div className="flex flex-wrap gap-1.5">
          <FilterPill
            label="All"
            active={filterCity === "All"}
            onClick={() => setFilterCity("All")}
          />
          {CITY_OPTIONS.map((c) => (
            <FilterPill
              key={c}
              label={c}
              active={filterCity === c}
              onClick={() => setFilterCity(c)}
            />
          ))}
        </div>

        {/* Add-action row — input + city + Add. Flex-wrap so mobile
            stacks gracefully on narrow viewports. */}
        <div className="flex flex-wrap items-stretch gap-2">
          <input
            type="text"
            value={draftBody}
            onChange={(e) => setDraftBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void addAction();
              }
            }}
            placeholder="Add an action…"
            className="min-w-[180px] flex-1 rounded-md border border-cream-line bg-white px-3 py-2 text-sm text-deep-green placeholder:text-deep-green/40 focus:border-deep-green focus:outline-none"
          />
          <select
            value={draftCity}
            onChange={(e) =>
              isCityValue(e.target.value) && setDraftCity(e.target.value)
            }
            className="rounded-md border border-cream-line bg-white px-3 py-2 text-sm text-deep-green focus:border-deep-green focus:outline-none"
            aria-label="Action city"
          >
            {CITY_OPTIONS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void addAction()}
            disabled={adding || draftBody.trim() === ""}
            className="rounded-full bg-mint px-5 py-2 text-sm font-bold text-deep-green transition hover:bg-mint-hover disabled:opacity-50"
          >
            {adding ? "Adding…" : "Add"}
          </button>
        </div>

        {error && (
          <div className="rounded-md border border-coral/40 bg-coral-soft px-3 py-2 text-xs text-coral">
            {error}
          </div>
        )}

        {/* Expanded list — lives inside the sticky element so the
            whole stack pins together when expanded. Internal scroll
            (max-h 60vh) keeps the bar usable even with many actions. */}
        {expanded && (
          <div className="mt-3 max-h-[60vh] overflow-y-auto rounded-2xl border-[1.5px] border-cream-line bg-white p-3 shadow-md shadow-deep-green/10">
            {loading ? (
              <div className="text-xs italic text-deep-green/45">Loading…</div>
            ) : filtered.length === 0 ? (
              <div className="rounded-md border border-cream-line bg-cream-soft/40 px-3 py-6 text-center text-sm italic text-deep-green/50">
                {actions.length === 0
                  ? "No actions yet. Add one above."
                  : `No actions for ${filterCity}.`}
              </div>
            ) : (
              <ul className="space-y-2">
                {filtered.map((a) => (
                  <ActionRow
                    key={a.id}
                    action={a}
                    comments={commentsByAction[a.id] ?? []}
                    callerEmail={callerEmail}
                    onChangeStatus={(s) => updateAction(a.id, { status: s })}
                    onChangeCity={(c) => updateAction(a.id, { city: c })}
                    onDelete={() => deleteAction(a.id)}
                    onAddComment={(body) => addComment(a.id, body)}
                  />
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function FilterPill({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium transition ${
        active
          ? "bg-deep-green text-cream"
          : "border border-deep-green/20 bg-transparent text-deep-green/70 hover:bg-cream-soft"
      }`}
    >
      {label}
    </button>
  );
}

// City tag pill — visually distinct from the status pill so the city
// is scannable at a row glance. Company-wide gets a muted style so it
// doesn't shout the way a real-city tag does.
function CityPill({ city }: { city: string }) {
  const isCompany = city === COMPANY_WIDE;
  return (
    <span
      className={`inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
        isCompany
          ? "bg-cream-line/60 text-deep-green/65"
          : "bg-deep-green text-cream"
      }`}
    >
      {city}
    </span>
  );
}

function StatusPill({ status }: { status: StatusValue }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${STATUS_PILL[status]}`}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

function ActionRow({
  action,
  comments,
  callerEmail,
  onChangeStatus,
  onChangeCity,
  onDelete,
  onAddComment,
}: {
  action: Action;
  comments: Comment[];
  callerEmail: string | null;
  onChangeStatus: (s: StatusValue) => void;
  onChangeCity: (c: string) => void;
  onDelete: () => void;
  onAddComment: (body: string) => void;
}) {
  const [showComments, setShowComments] = useState(false);
  const [draft, setDraft] = useState("");

  function submitComment() {
    const body = draft.trim();
    if (!body) return;
    onAddComment(body);
    setDraft("");
  }

  return (
    <li
      className={`rounded-lg border border-cream-line bg-white p-3 transition ${
        action.status === "resolved" ? "opacity-70" : ""
      }`}
    >
      {/* Top row: status + city + body + per-row controls */}
      <div className="flex items-start gap-3">
        <div className="flex shrink-0 flex-col items-start gap-1">
          <StatusPill status={action.status} />
          <CityPill city={action.city} />
        </div>
        <div className="min-w-0 flex-1">
          <div
            className={`text-sm text-deep-green ${
              action.status === "resolved" ? "line-through" : ""
            }`}
          >
            {action.body}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-deep-green/55">
            <span>by {action.created_by}</span>
            <span>· {fmtWhen(action.created_at)}</span>
            <button
              type="button"
              onClick={() => setShowComments((v) => !v)}
              className="font-bold uppercase tracking-wider text-deep-green/60 transition hover:text-deep-green"
            >
              {showComments ? "Hide" : "Show"} comments
              {comments.length > 0 ? ` (${comments.length})` : ""}
            </button>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <select
            value={action.status}
            onChange={(e) => onChangeStatus(e.target.value as StatusValue)}
            className="rounded border border-cream-line bg-white px-1.5 py-0.5 text-xs text-deep-green focus:border-deep-green focus:outline-none"
            aria-label="Change status"
          >
            {(Object.keys(STATUS_LABEL) as StatusValue[]).map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
          <select
            value={action.city}
            onChange={(e) => onChangeCity(e.target.value)}
            className="rounded border border-cream-line bg-white px-1.5 py-0.5 text-xs text-deep-green focus:border-deep-green focus:outline-none"
            aria-label="Change city"
          >
            {CITY_OPTIONS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={onDelete}
            className="text-[11px] font-medium text-deep-green/40 transition hover:text-coral"
            aria-label="Delete action"
          >
            Delete
          </button>
        </div>
      </div>

      {showComments && (
        <div className="mt-3 border-t border-cream-line/60 pt-3">
          {comments.length === 0 ? (
            <div className="text-xs italic text-deep-green/45">
              No comments yet.
            </div>
          ) : (
            <ul className="space-y-2">
              {comments.map((c) => (
                <li
                  key={c.id}
                  className="rounded-md bg-cream-soft/40 px-3 py-2 text-sm text-deep-green"
                >
                  <div>{c.body}</div>
                  <div className="mt-1 text-[11px] text-deep-green/55">
                    {c.created_by} · {fmtWhen(c.created_at)}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-2 flex items-stretch gap-2">
            <input
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submitComment();
                }
              }}
              placeholder="Add a comment…"
              disabled={!callerEmail}
              className="flex-1 rounded-md border border-cream-line bg-white px-3 py-1.5 text-sm text-deep-green placeholder:text-deep-green/40 focus:border-deep-green focus:outline-none disabled:bg-cream-soft/40"
            />
            <button
              type="button"
              onClick={submitComment}
              disabled={!callerEmail || draft.trim() === ""}
              className="rounded-full bg-mint px-4 py-1.5 text-xs font-bold text-deep-green transition hover:bg-mint-hover disabled:opacity-50"
            >
              Comment
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

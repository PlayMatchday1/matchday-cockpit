"use client";

import { useEffect, useMemo, useState } from "react";
import type { ReviewRow } from "@/lib/useReviewData";
import { getMonday, weekLabel } from "@/lib/cityStats";
import { classifyTag, type TagCategory } from "@/lib/reviewTags";

const WEEKS_BACK = 8;
const MONTHS_BACK = 12;

const MONTH_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

type WeekOption = {
  index: number;
  weekStart: Date;
  weekEndExclusive: Date; // Mon next week, exclusive upper bound
  label: string;
  range: string;
};

type MonthOption = {
  key: string; // "YYYY-MM"
  year: number;
  monthIdx: number;
  label: string; // "April 2026"
};

function buildWeekOptions(now: Date = new Date()): WeekOption[] {
  const currentMonday = getMonday(now);
  const out: WeekOption[] = [];
  for (let i = WEEKS_BACK - 1; i >= 0; i--) {
    const ws = new Date(
      currentMonday.getFullYear(),
      currentMonday.getMonth(),
      currentMonday.getDate() - 7 * i,
    );
    const weEx = new Date(
      ws.getFullYear(),
      ws.getMonth(),
      ws.getDate() + 7,
    );
    out.push({
      index: WEEKS_BACK - 1 - i,
      weekStart: ws,
      weekEndExclusive: weEx,
      label: weekLabel(ws),
      range: rangeLabel(ws),
    });
  }
  return out;
}

function buildMonthOptions(now: Date = new Date()): MonthOption[] {
  const out: MonthOption[] = [];
  const yr = now.getFullYear();
  const mo = now.getMonth();
  for (let i = 0; i < MONTHS_BACK; i++) {
    const d = new Date(yr, mo - i, 1);
    const y = d.getFullYear();
    const m = d.getMonth();
    out.push({
      key: `${y}-${String(m + 1).padStart(2, "0")}`,
      year: y,
      monthIdx: m,
      label: `${MONTH_LONG[m]} ${y}`,
    });
  }
  return out;
}

function previousMonthKey(now: Date = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function rangeLabel(weekStart: Date): string {
  const end = new Date(
    weekStart.getFullYear(),
    weekStart.getMonth(),
    weekStart.getDate() + 6,
  );
  const fmt = (d: Date) =>
    d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const yr = end.getFullYear();
  return `${fmt(weekStart)} – ${fmt(end)}, ${yr}`;
}

function fmtDateTime(d: Date | null): string {
  if (!d) return "—";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function fmtDateOnly(d: Date | null): string {
  if (!d) return "—";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function TagPill({
  tag,
  category,
}: {
  tag: string;
  category: TagCategory;
}) {
  const cls =
    category === "positive"
      ? "bg-mint/30 text-deep-green ring-mint/40"
      : category === "negative"
        ? "bg-coral/30 text-coral ring-coral/40"
        : "bg-cream-soft text-deep-green/75 ring-cream-line";
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ring-1 ring-inset ${cls}`}
    >
      {tag}
    </span>
  );
}

function StarRating({ rating }: { rating: number }) {
  const r = Math.round(rating);
  const filled = "★".repeat(r);
  const empty = "☆".repeat(5 - r);
  const cls =
    r <= 2
      ? "text-coral"
      : r === 3
        ? "text-gold"
        : "text-mint-hover";
  return (
    <span
      className={`inline-flex items-center gap-1 font-mono tabular-nums ${cls}`}
    >
      <span aria-hidden className="text-base leading-none">
        {filled}
        <span className="text-deep-green/20">{empty}</span>
      </span>
      <span className="text-xs font-bold">{r}</span>
    </span>
  );
}

type CommonProps = { rows: ReviewRow[] };
type WeeklyProps = CommonProps & { scope?: "weekly" };
type MonthlyProps = CommonProps & {
  scope: "monthly";
  city: string;
  defaultMonthKey?: string;
};
export type ReviewsCommentsTableProps = WeeklyProps | MonthlyProps;

export default function ReviewsCommentsTable(props: ReviewsCommentsTableProps) {
  if (props.scope === "monthly") {
    return (
      <MonthlyComments
        rows={props.rows}
        city={props.city}
        defaultMonthKey={props.defaultMonthKey}
      />
    );
  }
  return <WeeklyComments rows={props.rows} />;
}

// -----------------------------------------------------------------
// Weekly mode (all-cities Reviews tab) — unchanged behavior.
// -----------------------------------------------------------------

function WeeklyComments({ rows }: { rows: ReviewRow[] }) {
  const weekOptions = useMemo(() => buildWeekOptions(), []);
  const defaultIdx = weekOptions[weekOptions.length - 1].index;
  const [weekIdx, setWeekIdx] = useState<number>(defaultIdx);
  const [city, setCity] = useState<string>("ALL");

  const cityOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) if (r.city) set.add(r.city);
    return ["ALL", ...[...set].sort()];
  }, [rows]);

  const week =
    weekOptions.find((w) => w.index === weekIdx) ??
    weekOptions[weekOptions.length - 1];

  const filtered = useMemo(() => {
    const out: ReviewRow[] = [];
    for (const r of rows) {
      if (!isCommentOrOneStar(r)) continue;
      if (!r.ratingAt) continue;
      if (
        r.ratingAt.getTime() < week.weekStart.getTime() ||
        r.ratingAt.getTime() >= week.weekEndExclusive.getTime()
      )
        continue;
      if (city !== "ALL" && r.city !== city) continue;
      out.push(r);
    }
    return sortByRatingAtDesc(out);
  }, [rows, week, city]);

  const cityLabel = city === "ALL" ? "All cities" : city;

  return (
    <CommentsShell
      title="Comments"
      subtitle="Player feedback for response."
      controls={
        <>
          <label className="block">
            <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.18em] text-deep-green/55">
              Week
            </div>
            <select
              value={weekIdx}
              onChange={(e) => setWeekIdx(Number(e.target.value))}
              className="rounded-md border border-cream-line bg-cream-soft px-3 py-1.5 text-sm font-bold text-deep-green focus:border-deep-green focus:outline-none"
            >
              {[...weekOptions].reverse().map((w) => (
                <option key={w.index} value={w.index}>
                  {w.range}
                  {w.index === defaultIdx ? " (this week)" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.18em] text-deep-green/55">
              City
            </div>
            <select
              value={city}
              onChange={(e) => setCity(e.target.value)}
              className="rounded-md border border-cream-line bg-cream-soft px-3 py-1.5 text-sm font-bold text-deep-green focus:border-deep-green focus:outline-none"
            >
              {cityOptions.map((c) => (
                <option key={c} value={c}>
                  {c === "ALL" ? "All cities" : c}
                </option>
              ))}
            </select>
          </label>
        </>
      }
      countLine={
        <>
          <span className="font-mono font-bold tabular-nums text-deep-green">
            {filtered.length}
          </span>{" "}
          review{filtered.length === 1 ? "" : "s"}{" "}
          <span className="text-deep-green/45">
            (comments + 1-star ratings)
          </span>{" "}
          · <span className="font-mono">{week.range}</span> · {cityLabel}
        </>
      }
      rows={filtered}
      emptyText="No comments or 1-star reviews this week."
    />
  );
}

// -----------------------------------------------------------------
// Monthly mode (city detail page).
// -----------------------------------------------------------------

function MonthlyComments({
  rows,
  city,
  defaultMonthKey,
}: {
  rows: ReviewRow[];
  city: string;
  defaultMonthKey?: string;
}) {
  const monthOptions = useMemo(() => buildMonthOptions(), []);
  const fallbackKey = useMemo(() => previousMonthKey(), []);
  const initialKey =
    defaultMonthKey && monthOptions.some((m) => m.key === defaultMonthKey)
      ? defaultMonthKey
      : (monthOptions.find((m) => m.key === fallbackKey)?.key ??
        monthOptions[1]?.key ??
        monthOptions[0].key);
  const [monthKey, setMonthKey] = useState<string>(initialKey);

  // If the URL changes (back/forward, or another link in-app), pick up
  // the new month. Without this, navigating to the same page with a
  // different ?month query keeps the old selection in state.
  useEffect(() => {
    if (
      defaultMonthKey &&
      defaultMonthKey !== monthKey &&
      monthOptions.some((m) => m.key === defaultMonthKey)
    ) {
      setMonthKey(defaultMonthKey);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultMonthKey]);

  const month =
    monthOptions.find((m) => m.key === monthKey) ?? monthOptions[0];

  const filtered = useMemo(() => {
    const out: ReviewRow[] = [];
    for (const r of rows) {
      if (r.city !== city) continue;
      if (!isCommentOrOneStar(r)) continue;
      if (!r.ratingAt) continue;
      if (
        r.ratingAt.getFullYear() !== month.year ||
        r.ratingAt.getMonth() !== month.monthIdx
      )
        continue;
      out.push(r);
    }
    return sortByRatingAtDesc(out);
  }, [rows, city, month]);

  return (
    <CommentsShell
      title="Comments"
      subtitle={`Player feedback for ${city}.`}
      controls={
        <label className="block">
          <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.18em] text-deep-green/55">
            Month
          </div>
          <select
            value={monthKey}
            onChange={(e) => setMonthKey(e.target.value)}
            className="rounded-md border border-cream-line bg-cream-soft px-3 py-1.5 text-sm font-bold text-deep-green focus:border-deep-green focus:outline-none"
          >
            {monthOptions.map((m) => (
              <option key={m.key} value={m.key}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
      }
      countLine={
        <>
          <span className="font-mono font-bold tabular-nums text-deep-green">
            {filtered.length}
          </span>{" "}
          review{filtered.length === 1 ? "" : "s"}{" "}
          <span className="text-deep-green/45">
            (comments + 1-star ratings)
          </span>{" "}
          · <span className="font-mono">{month.label}</span> · {city}
        </>
      }
      rows={filtered}
      emptyText="No comments or 1-star reviews this month."
    />
  );
}

// -----------------------------------------------------------------
// Shared shell + helpers.
// -----------------------------------------------------------------

function isCommentOrOneStar(r: ReviewRow): boolean {
  const hasComment = Boolean(r.comment && r.comment.trim());
  const isOneStar = r.starRating === 1;
  return hasComment || isOneStar;
}

function sortByRatingAtDesc(rows: ReviewRow[]): ReviewRow[] {
  return [...rows].sort((a, b) => {
    const ta = a.ratingAt ? a.ratingAt.getTime() : 0;
    const tb = b.ratingAt ? b.ratingAt.getTime() : 0;
    return tb - ta;
  });
}

function CommentsShell({
  title,
  subtitle,
  controls,
  countLine,
  rows,
  emptyText,
}: {
  title: string;
  subtitle: string;
  controls: React.ReactNode;
  countLine: React.ReactNode;
  rows: ReviewRow[];
  emptyText: string;
}) {
  return (
    <section className="rounded-2xl border-[1.5px] border-cream-line bg-white p-6 shadow-md shadow-deep-green/10 sm:p-7">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="text-2xl font-bold tracking-tight text-deep-green">
            {title}
          </h3>
          <p className="mt-1 text-sm text-deep-green/65">{subtitle}</p>
        </div>
        <div className="flex flex-wrap items-end gap-3">{controls}</div>
      </div>

      <div className="mb-3 text-xs text-deep-green/65">{countLine}</div>

      {rows.length === 0 ? (
        <div className="rounded-md border border-cream-line bg-cream-soft/40 px-4 py-10 text-center text-sm text-deep-green/55">
          {emptyText}
        </div>
      ) : (
        <CommentsTableBody rows={rows} />
      )}
    </section>
  );
}

function CommentsTableBody({ rows }: { rows: ReviewRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="bg-cream-soft text-[10px] font-bold uppercase tracking-wider text-deep-green/60">
          <tr className="border-b border-cream-line">
            <th className="px-3 py-2 text-left">Submitted</th>
            <th className="px-3 py-2 text-left">Rating</th>
            <th className="px-3 py-2 text-left">Comment</th>
            <th className="px-3 py-2 text-left">Tags</th>
            <th className="px-3 py-2 text-left">Player</th>
            <th className="px-3 py-2 text-left">Email</th>
            <th className="px-3 py-2 text-left">Match Date</th>
            <th className="px-3 py-2 text-left">Field</th>
            <th className="px-3 py-2 text-left">City</th>
            <th className="px-3 py-2 text-left">Manager</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const player =
              [r.userFirstName, r.userLastName].filter(Boolean).join(" ") ||
              "—";
            return (
              <tr
                key={`${r.userId ?? "x"}-${r.ratingAt?.getTime() ?? i}-${i}`}
                className="border-t border-cream-line/40 hover:bg-cream-soft/40"
              >
                <td className="whitespace-nowrap px-3 py-2 align-top font-mono tabular-nums text-deep-green">
                  {fmtDateTime(r.ratingAt)}
                </td>
                <td className="whitespace-nowrap px-3 py-2 align-top">
                  <StarRating rating={r.starRating} />
                </td>
                <td className="px-3 py-2 align-top text-deep-green">
                  {r.comment ? (
                    <div className="max-w-[460px] whitespace-pre-wrap break-words leading-snug">
                      {r.comment}
                    </div>
                  ) : (
                    <span className="italic text-deep-green/40">
                      (no comment)
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 align-top">
                  {r.tags.length > 0 && (
                    <div className="flex max-w-[260px] flex-wrap gap-1">
                      {r.tags.map((tag, ti) => (
                        <TagPill
                          key={`${tag}-${ti}`}
                          tag={tag}
                          category={classifyTag(tag)}
                        />
                      ))}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2 align-top text-deep-green/85">
                  {player}
                </td>
                <td className="px-3 py-2 align-top">
                  {r.userEmail ? (
                    <a
                      href={`mailto:${r.userEmail}`}
                      className="break-all font-mono text-mint-hover underline-offset-2 hover:underline"
                    >
                      {r.userEmail}
                    </a>
                  ) : (
                    <span className="text-deep-green/40">—</span>
                  )}
                </td>
                <td className="whitespace-nowrap px-3 py-2 align-top text-deep-green/85">
                  {fmtDateOnly(r.startDate)}
                </td>
                <td className="px-3 py-2 align-top text-deep-green/85">
                  {r.fieldTitle || "—"}
                </td>
                <td className="whitespace-nowrap px-3 py-2 align-top text-deep-green/85">
                  {r.city}
                </td>
                <td className="px-3 py-2 align-top text-deep-green/85">
                  {r.managerFirstName ?? "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

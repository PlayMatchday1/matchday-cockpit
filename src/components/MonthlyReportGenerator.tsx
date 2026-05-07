"use client";

// Monthly City Manager Report generator. Pre-fills a city/month report
// from existing data hooks (useFinanceData for revenue, useReviewData
// for review aggregations) so the user only writes the Focus section
// and tweaks the auto-generated intro before clicking Copy as email.
//
// Auto-gen intro: rules-based phrase assembly seeded by city-name hash
// so re-clicking Generate is deterministic, but different cities get
// different verb choices. Voice rules: no em-dashes, no AI vocabulary,
// concrete numbers and names, 2-3 sentences.

import { useMemo, useState } from "react";
import { useFinanceData } from "@/lib/useFinanceData";
import { useReviewData } from "@/lib/useReviewData";
import { CITIES, type City, citySlug } from "@/lib/types";

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

const MONTH_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

type MonthKey = { idx: number; year: number; label: string };

// 24 months going back from today, formatted "Mar 2026" to match
// fin_revenue.month strings.
function buildMonthOptions(now: Date): MonthKey[] {
  const out: MonthKey[] = [];
  const year = now.getFullYear();
  const month = now.getMonth();
  for (let i = 0; i < 24; i++) {
    const d = new Date(year, month - i, 1);
    out.push({
      idx: d.getMonth(),
      year: d.getFullYear(),
      label: `${MONTH_SHORT[d.getMonth()]} ${d.getFullYear()}`,
    });
  }
  return out;
}

function priorMonth(m: MonthKey): MonthKey {
  const d = new Date(m.year, m.idx - 1, 1);
  return {
    idx: d.getMonth(),
    year: d.getFullYear(),
    label: `${MONTH_SHORT[d.getMonth()]} ${d.getFullYear()}`,
  };
}

function nextMonth(m: MonthKey): MonthKey {
  const d = new Date(m.year, m.idx + 1, 1);
  return {
    idx: d.getMonth(),
    year: d.getFullYear(),
    label: `${MONTH_SHORT[d.getMonth()]} ${d.getFullYear()}`,
  };
}

function fmtMoney(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  });
}

// Money inside the intro paragraph — no decimals, looks cleaner in
// prose. Email body still shows two decimals for the structured row.
function fmtMoneyTerse(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

// Stable hash of a city name → small int. Used to deterministically
// pick a phrasing template per city so different cities read
// differently but the same city always reads the same way.
function cityHash(city: string): number {
  let h = 0;
  for (let i = 0; i < city.length; i++) {
    h = (h * 31 + city.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

type ManagerAgg = { name: string; count: number; avg: number };

type ReportData = {
  revenueGross: number;
  revenuePrior: number;
  reviewCount: number;
  cityAvgRating: number; // 0 if reviewCount === 0
  managers: ManagerAgg[];
};

function generateIntro(
  city: string,
  monthLong: string,
  priorMonthLong: string,
  d: ReportData,
): string {
  const seed = cityHash(city);
  const sentences: string[] = [];

  // Sentence 1 — revenue
  if (d.revenueGross === 0 && d.revenuePrior === 0) {
    sentences.push(`${city} had no revenue activity in ${monthLong}.`);
  } else if (d.revenuePrior === 0) {
    // First month with revenue, no prior to compare.
    sentences.push(
      `${city} came in at ${fmtMoneyTerse(d.revenueGross)} in ${monthLong}.`,
    );
  } else {
    const delta = (d.revenueGross - d.revenuePrior) / d.revenuePrior;
    const cur = fmtMoneyTerse(d.revenueGross);
    const prior = fmtMoneyTerse(d.revenuePrior);
    if (delta > 0.05) {
      const upTemplates = [
        `${city} jumped to ${cur} in ${monthLong} from ${prior} in ${priorMonthLong}.`,
        `${city} stepped up to ${cur} in ${monthLong}, up from ${prior} in ${priorMonthLong}.`,
        `${city} came in at ${cur} in ${monthLong}, up from ${prior} last month.`,
      ];
      sentences.push(upTemplates[seed % upTemplates.length]);
    } else if (delta < -0.05) {
      const downTemplates = [
        `${city} softened to ${cur} in ${monthLong} from ${prior} in ${priorMonthLong}.`,
        `${city} dipped to ${cur} in ${monthLong}, down from ${prior} last month.`,
        `${city} slowed to ${cur} in ${monthLong} after ${prior} in ${priorMonthLong}.`,
      ];
      sentences.push(downTemplates[seed % downTemplates.length]);
    } else {
      // Flat band: -5% to +5%. Use the user's preferred phrasings —
      // "down slightly" / "vs $X" / "after $X" / "up slightly".
      const direction =
        delta < 0
          ? "down slightly"
          : delta > 0
            ? "up slightly"
            : "even with";
      const flatTemplates = [
        `${city} held at ${cur} in ${monthLong}, ${direction} from ${prior} last month.`,
        `${city} came in at ${cur} in ${monthLong} vs ${prior} in ${priorMonthLong}.`,
        `${city} held at ${cur} in ${monthLong} after ${prior} last month.`,
      ];
      sentences.push(flatTemplates[seed % flatTemplates.length]);
    }
  }

  // Sentence 2 — rating
  if (d.reviewCount > 0) {
    const ratingTemplates = [
      `Ratings landed at ${d.cityAvgRating.toFixed(2)} across ${d.reviewCount} reviews.`,
      `The city averaged ${d.cityAvgRating.toFixed(2)} stars across ${d.reviewCount} reviews.`,
      `${d.reviewCount} reviews came in at ${d.cityAvgRating.toFixed(2)} on average.`,
    ];
    sentences.push(ratingTemplates[(seed + 1) % ratingTemplates.length]);
  }

  // Sentence 3 — top manager (only if there's a clear leader on volume)
  const topMgr = d.managers[0];
  if (topMgr && topMgr.count > 0) {
    const topTemplates = [
      `${topMgr.name} led volume with ${topMgr.count} reviews at ${topMgr.avg.toFixed(2)}.`,
      `${topMgr.name} topped the standings, ${topMgr.count} reviews at ${topMgr.avg.toFixed(2)}.`,
      `${topMgr.name} ran the most matches, ${topMgr.count} reviews at ${topMgr.avg.toFixed(2)}.`,
    ];
    sentences.push(topTemplates[(seed + 2) % topTemplates.length]);
  }

  return sentences.join(" ");
}

// Build the email body in two formats. Gmail compose picks HTML on
// paste and renders the manager table; plain text is the fallback for
// other targets.
function buildEmailBodies(args: {
  city: string;
  monthLong: string;
  nextMonthLong: string;
  intro: string;
  focus: string;
  d: ReportData;
  reviewLink: string;
}) {
  const { city, monthLong, nextMonthLong, intro, focus, d, reviewLink } = args;
  const revenueLine =
    d.revenuePrior > 0
      ? `${monthLong} Revenue: ${fmtMoney(d.revenueGross)} (${fmtMoney(d.revenuePrior)} last month)`
      : `${monthLong} Revenue: ${fmtMoney(d.revenueGross)}`;
  const ratingLine =
    d.reviewCount > 0
      ? `City Average Rating: ${d.cityAvgRating.toFixed(2)}`
      : `City Average Rating: no reviews this month`;

  // Plain text version.
  const plainParts: string[] = [];
  if (intro.trim()) plainParts.push(intro.trim());
  if (focus.trim()) {
    plainParts.push(`${nextMonthLong} Focus:\n${focus.trim()}`);
  }
  plainParts.push(revenueLine);
  plainParts.push(ratingLine);
  if (d.managers.length > 0) {
    const tableLines = ["", "Manager performance:"];
    const namePad = Math.max(...d.managers.map((m) => m.name.length), 8) + 2;
    for (const m of d.managers) {
      const name = m.name.padEnd(namePad);
      tableLines.push(
        `  ${name}${String(m.count).padStart(3)} reviews, ${m.avg.toFixed(2)}`,
      );
    }
    plainParts.push(tableLines.join("\n"));
  }
  plainParts.push(
    `${monthLong} post match feedback from players: view all reviews → ${reviewLink}`,
  );
  const plain = plainParts.join("\n\n");

  // HTML version — minimal markup so Gmail's sanitizer keeps it.
  const escape = (s: string) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  const introHtml = intro.trim()
    ? `<p>${escape(intro.trim()).replace(/\n/g, "<br>")}</p>`
    : "";
  const focusHtml = focus.trim()
    ? `<p><strong>${escape(nextMonthLong)} Focus:</strong><br>${escape(focus.trim()).replace(/\n/g, "<br>")}</p>`
    : "";
  const tableRows = d.managers
    .map(
      (m) =>
        `<tr><td style="padding:2px 18px 2px 0;">${escape(m.name)}</td><td style="padding:2px 18px 2px 0;text-align:right;">${m.count}</td><td style="padding:2px 0;text-align:right;">${m.avg.toFixed(2)}</td></tr>`,
    )
    .join("");
  const tableHtml =
    d.managers.length > 0
      ? `<p><strong>Manager performance:</strong></p><table cellpadding="0" cellspacing="0" style="border-collapse:collapse;"><thead><tr><th style="padding:2px 18px 2px 0;text-align:left;">Manager</th><th style="padding:2px 18px 2px 0;text-align:right;">Reviews</th><th style="padding:2px 0;text-align:right;">Rating</th></tr></thead><tbody>${tableRows}</tbody></table>`
      : "";
  const linkHtml = `<p>${escape(monthLong)} post match feedback from players: <a href="${reviewLink}">view all reviews →</a></p>`;
  const html = `<div>${introHtml}${focusHtml}<p>${escape(revenueLine)}<br>${escape(ratingLine)}</p>${tableHtml}${linkHtml}</div>`;

  return { plain, html };
}

async function copyToClipboard(plain: string, html: string): Promise<boolean> {
  try {
    if (navigator.clipboard && typeof ClipboardItem !== "undefined") {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([plain], { type: "text/plain" }),
        }),
      ]);
      return true;
    }
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(plain);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export default function MonthlyReportGenerator() {
  const today = useMemo(() => new Date(), []);
  const monthOptions = useMemo(() => buildMonthOptions(today), [today]);
  const defaultMonth = monthOptions[1] ?? monthOptions[0]; // previous calendar month

  const [city, setCity] = useState<City>("San Antonio");
  const [selectedLabel, setSelectedLabel] = useState<string>(defaultMonth.label);
  const selectedMonth = useMemo(
    () =>
      monthOptions.find((m) => m.label === selectedLabel) ?? defaultMonth,
    [monthOptions, selectedLabel, defaultMonth],
  );

  const finance = useFinanceData();
  const reviews = useReviewData();
  const dataLoading = finance.loading || reviews.loading;

  const [generated, setGenerated] = useState<{
    city: City;
    month: MonthKey;
    data: ReportData;
  } | null>(null);
  const [introText, setIntroText] = useState<string>("");
  const [focusText, setFocusText] = useState<string>("");
  const [bodyToast, setBodyToast] = useState<string>("");
  const [subjectToast, setSubjectToast] = useState<string>("");

  function compute(c: City, m: MonthKey): ReportData {
    const cur = finance.data?.revenue ?? [];
    const revenueGross = cur
      .filter((r) => r.city === c && r.month === m.label)
      .reduce((s, r) => s + (r.gross ?? 0), 0);
    const prior = priorMonth(m);
    const revenuePrior = cur
      .filter((r) => r.city === c && r.month === prior.label)
      .reduce((s, r) => s + (r.gross ?? 0), 0);

    const monthRows = reviews.rows.filter(
      (r) =>
        r.city === c &&
        r.startDate.getFullYear() === m.year &&
        r.startDate.getMonth() === m.idx,
    );
    const reviewCount = monthRows.length;
    const cityAvgRating =
      reviewCount > 0
        ? monthRows.reduce((s, r) => s + r.starRating, 0) / reviewCount
        : 0;
    const byMgr = new Map<string, { count: number; sum: number }>();
    for (const r of monthRows) {
      const name = r.managerFirstName?.trim();
      if (!name) continue;
      const e = byMgr.get(name) ?? { count: 0, sum: 0 };
      e.count += 1;
      e.sum += r.starRating;
      byMgr.set(name, e);
    }
    const managers: ManagerAgg[] = [...byMgr.entries()]
      .map(([name, e]) => ({
        name,
        count: e.count,
        avg: e.count > 0 ? e.sum / e.count : 0,
      }))
      .sort((a, b) => b.count - a.count || b.avg - a.avg);
    return { revenueGross, revenuePrior, reviewCount, cityAvgRating, managers };
  }

  function handleGenerate() {
    const m = selectedMonth;
    const d = compute(city, m);
    setGenerated({ city, month: m, data: d });
    setIntroText(
      generateIntro(city, MONTH_LONG[m.idx], MONTH_LONG[priorMonth(m).idx], d),
    );
    // Focus is preserved across regenerations (per spec).
  }

  const subject = generated
    ? `${MONTH_LONG[generated.month.idx]} ${generated.city} Report`
    : "";
  const nextMonthLabel = generated
    ? MONTH_LONG[nextMonth(generated.month).idx]
    : "";
  // Deep-link to the city detail page with the report month pre-selected
  // on the Comments table. ?month=YYYY-MM is parsed by CityDetailView's
  // search-params hook; #comments anchors to the section so the page
  // scrolls past the four stat cards to the table on load.
  const reviewLink = generated
    ? `/cities/${citySlug(generated.city)}?month=${generated.month.year}-${String(generated.month.idx + 1).padStart(2, "0")}#comments`
    : "";

  async function handleCopyEmail() {
    if (!generated) return;
    const { plain, html } = buildEmailBodies({
      city: generated.city,
      monthLong: MONTH_LONG[generated.month.idx],
      nextMonthLong: nextMonthLabel,
      intro: introText,
      focus: focusText,
      d: generated.data,
      reviewLink,
    });
    const ok = await copyToClipboard(plain, html);
    setBodyToast(ok ? "Copied!" : "Copy failed");
    window.setTimeout(() => setBodyToast(""), 1800);
  }

  async function handleCopySubject() {
    if (!subject) return;
    const ok = await copyText(subject);
    setSubjectToast(ok ? "Copied!" : "Copy failed");
    window.setTimeout(() => setSubjectToast(""), 1800);
  }

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-6 shadow-md shadow-deep-green/10">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="City">
            <select
              value={city}
              onChange={(e) => setCity(e.target.value as City)}
              className="w-full rounded-md border border-cream-line bg-white px-3 py-2 text-sm text-deep-green focus:border-deep-green focus:outline-none"
            >
              {CITIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Month">
            <select
              value={selectedLabel}
              onChange={(e) => setSelectedLabel(e.target.value)}
              className="w-full rounded-md border border-cream-line bg-white px-3 py-2 text-sm text-deep-green focus:border-deep-green focus:outline-none"
            >
              {monthOptions.map((m) => (
                <option key={m.label} value={m.label}>
                  {MONTH_LONG[m.idx]} {m.year}
                </option>
              ))}
            </select>
          </Field>
          <div className="flex items-end">
            <button
              type="button"
              onClick={handleGenerate}
              disabled={dataLoading}
              className="w-full rounded-md bg-mint px-4 py-2 text-sm font-bold text-deep-green transition hover:bg-mint-hover disabled:opacity-50"
            >
              {dataLoading ? "Loading data…" : "Generate"}
            </button>
          </div>
        </div>
      </div>

      {generated && (
        <div className="space-y-4 rounded-2xl border-[1.5px] border-cream-line bg-white p-6 shadow-md shadow-deep-green/10">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-cream-line pb-4">
            <div className="min-w-0">
              <div className="text-[11px] font-bold uppercase tracking-[0.25em] text-deep-green/60">
                Subject
              </div>
              <div className="mt-1 break-words font-mono text-sm text-deep-green">
                {subject}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleCopySubject}
                className="rounded-md border border-cream-line px-3 py-1.5 text-xs font-bold text-deep-green transition hover:bg-cream-soft"
              >
                Copy subject
              </button>
              {subjectToast && (
                <span className="text-xs font-bold text-mint-hover">
                  {subjectToast}
                </span>
              )}
              <button
                type="button"
                onClick={handleCopyEmail}
                className="rounded-md bg-deep-green px-3 py-1.5 text-xs font-bold text-cream transition hover:bg-deep-green-soft"
              >
                Copy as email
              </button>
              {bodyToast && (
                <span className="text-xs font-bold text-mint-hover">
                  {bodyToast}
                </span>
              )}
            </div>
          </div>

          <Field label="Intro (editable, auto-generated)">
            <textarea
              value={introText}
              onChange={(e) => setIntroText(e.target.value)}
              rows={4}
              className="w-full resize-y rounded-md border border-cream-line bg-white px-3 py-2 text-sm text-deep-green focus:border-deep-green focus:outline-none"
            />
            <p className="mt-1 text-[11px] text-deep-green/55">
              Starting draft. Edit before copying. Re-clicking Generate
              overwrites this field.
            </p>
          </Field>

          <Field label={`${nextMonthLabel} Focus:`}>
            <textarea
              value={focusText}
              onChange={(e) => setFocusText(e.target.value)}
              rows={5}
              placeholder={"1. \n2. \n3. "}
              className="w-full resize-y rounded-md border border-cream-line bg-white px-3 py-2 text-sm text-deep-green focus:border-deep-green focus:outline-none"
            />
            <p className="mt-1 text-[11px] text-deep-green/55">
              Manual. Preserved when you switch city/month and re-generate.
            </p>
          </Field>

          <div className="rounded-md border border-cream-line bg-cream-soft p-4 text-sm text-deep-green">
            <div>
              <strong>{MONTH_LONG[generated.month.idx]} Revenue:</strong>{" "}
              {fmtMoney(generated.data.revenueGross)}{" "}
              {generated.data.revenuePrior > 0 && (
                <span className="text-deep-green/65">
                  ({fmtMoney(generated.data.revenuePrior)} last month)
                </span>
              )}
            </div>
            <div className="mt-1">
              <strong>City Average Rating:</strong>{" "}
              {generated.data.reviewCount > 0
                ? generated.data.cityAvgRating.toFixed(2)
                : "no reviews this month"}
            </div>
            {generated.data.managers.length > 0 && (
              <table className="mt-4 w-full max-w-md border-collapse text-sm">
                <thead>
                  <tr className="border-b border-cream-line text-left text-[11px] uppercase tracking-wider text-deep-green/60">
                    <th className="py-1.5 pr-4">Manager</th>
                    <th className="py-1.5 pr-4 text-right">Reviews</th>
                    <th className="py-1.5 text-right">Rating</th>
                  </tr>
                </thead>
                <tbody>
                  {generated.data.managers.map((m) => (
                    <tr
                      key={m.name}
                      className="border-b border-cream-line/60 last:border-b-0"
                    >
                      <td className="py-1.5 pr-4 font-medium">{m.name}</td>
                      <td className="py-1.5 pr-4 text-right tabular-nums">
                        {m.count}
                      </td>
                      <td className="py-1.5 text-right tabular-nums">
                        {m.avg.toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="mt-4">
              {MONTH_LONG[generated.month.idx]} post match feedback from players:{" "}
              <a
                href={reviewLink}
                className="font-bold text-mint-hover hover:underline"
              >
                view all reviews →
              </a>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="mb-1 text-[11px] font-bold uppercase tracking-wider text-deep-green/65">
        {label}
      </div>
      {children}
    </label>
  );
}

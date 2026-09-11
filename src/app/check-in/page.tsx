"use client";

// PUBLIC (no-login) City Manager Check-In form. Lives OUTSIDE the (internal) route group, so it
// inherits no auth — same placement and reasoning as /inventory. Reads NO data. Submits one row to
// /api/city-check-ins/submit, which is guarded (honeypot + IP rate limit + validation) and inserts
// with the service-role key; anon has no policies on the table at all.
//
// Ryan: "page like inventory link instead of forms. I want it to be open its not sensitive and not
// all city managers have the checkin". Some of the people who file this have no Clubhouse account,
// so this must not be behind /city/* and must not personalise anything from a session.
//
// ── NO NAME FIELD. THE CITY IS THE IDENTITY. ─────────────────────────────────────────────────
// It used to ask. The answer was discarded: the dashboard card's title is MANAGERS[].name keyed on
// cityId, so filing as "Ryan Mancuso" for Austin produced a card titled "Garrett Suits". The name
// is now RESOLVED FROM THE CITY and shown back under the select — from the static MANAGERS list,
// not from a session, because there is no session here — so a wrong city is caught before submit
// rather than on a card a week later. The route stamps the same value server-side.
//
// ── ON HINTS, WHICH REVERSES THIS FILE'S PREVIOUS RULE ───────────────────────────────────────
// This header used to read "NO EXPLAINER COPY ... no hint under any field". That rule is right for
// a DASHBOARD, where a caption explains something the reader is already looking at. It is wrong
// for a FORM, where the hint IS THE SPECIFICATION OF THE ANSWER: "N/A if this is not an active
// goal for your city" is what tells a manager to type N/A instead of leaving the box blank, and
// the card renders blank and "N/A" differently. The hints live in CHECK_IN_QUESTIONS.
//
// STILL BANNED, and the suite asserts it: a subtitle explaining what a check-in is, a note about
// who reads it, a confirmation paragraph, anything about the form being public — and the word
// "week", because this is a monthly check-in and the Google Form's own copy says otherwise.

import { useMemo, useState } from "react";
import {
  CHECK_IN_QUESTIONS,
  CHECK_IN_SECTIONS,
  CHECK_IN_CITY_OPTIONS,
  RATING_OPTIONS,
  RATING_ANCHOR_LOW,
  RATING_ANCHOR_HIGH,
  defaultMonthEnding,
  managerNameForCity,
  type CheckInTextKey,
} from "@/lib/cityCheckIns";

type Answers = Record<CheckInTextKey, string>;
const EMPTY: Answers = Object.fromEntries(
  CHECK_IN_QUESTIONS.map((q) => [q.key, ""]),
) as Answers;

// Five cards: the city/month one, then the four question sections. The counter says how far in you
// are, which nine identical boxes in one column never did.
const TOTAL_SECTIONS = CHECK_IN_SECTIONS.length + 1;

export default function CityCheckInPage() {
  const [city, setCity] = useState("");
  const [monthEnding, setMonthEnding] = useState(() => defaultMonthEnding(new Date()));
  const [rating, setRating] = useState("");
  const [answers, setAnswers] = useState<Answers>(EMPTY);
  const [website, setWebsite] = useState(""); // honeypot
  const [status, setStatus] = useState<"idle" | "saving" | "done">("idle");
  const [error, setError] = useState<string | null>(null);

  const filingAs = useMemo(() => (city ? managerNameForCity(city) : null), [city]);
  const setAnswer = (k: CheckInTextKey, v: string, max: number) =>
    setAnswers((a) => ({ ...a, [k]: v.slice(0, max) }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!city) return setError("Please pick your city.");
    if (!monthEnding) return setError("Please pick the month ending date.");
    if (!rating) return setError("Please pick an overall rating.");
    setStatus("saving");
    try {
      const res = await fetch("/api/city-check-ins/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          city_identifier: city,
          month_ending: monthEnding,
          rating,
          ...answers,
          website,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || "Something went wrong. Please try again.");
      }
      setStatus("done");
    } catch (err) {
      setStatus("idle");
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (status === "done") {
    return (
      <Shell>
        <div className="rounded-2xl border border-cream-line bg-white p-8 text-center shadow-sm">
          <div className="text-4xl">✅</div>
          <h2 className="mt-3 font-display text-2xl uppercase tracking-tight text-deep-green">
            Thanks{filingAs ? `, ${filingAs.split(/\s+/)[0]}` : ""}!
          </h2>
          <button
            type="button"
            onClick={() => {
              setCity("");
              setMonthEnding(defaultMonthEnding(new Date()));
              setRating("");
              setAnswers(EMPTY);
              setStatus("idle");
            }}
            className="mt-5 rounded-xl border border-cream-line bg-white px-4 py-2 text-sm font-bold text-deep-green transition hover:bg-cream-soft"
          >
            Submit another
          </button>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <form onSubmit={submit}>
        {/* Honeypot — off-screen, not for humans. */}
        <div aria-hidden className="pointer-events-none absolute -left-[9999px] top-0">
          <label>
            Website
            <input
              tabIndex={-1}
              autoComplete="off"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
            />
          </label>
        </div>

        {/* ── 1 · who and when ── */}
        <Card n={1} title="Your city" blurb="Your name comes from the city, so there is nothing to type here.">
          <div className="grid gap-4 sm:grid-cols-2">
            <Q label="City" required>
              {/* Value is the city_identifier, label is the display name — the stored value is a
                  join key and the manager still reads "Houston". */}
              <select
                data-testid="ci-city"
                value={city}
                onChange={(e) => setCity(e.target.value)}
                className={inputCls}
              >
                <option value="">Select your city…</option>
                {CHECK_IN_CITY_OPTIONS.map((c) => (
                  <option key={c.identifier} value={c.identifier}>
                    {c.name}
                  </option>
                ))}
              </select>
              {/* THE NAME, RESOLVED AND SHOWN BACK — not an input. A city with no manager on file
                  says so in words; it must still be able to file. */}
              <span data-testid="ci-filing-as" className={hintCls}>
                {!city
                  ? "Pick your city and we will fill in your name."
                  : filingAs
                    ? `Filing as ${filingAs}`
                    : "No city manager is on file for this city yet."}
              </span>
            </Q>
            <Q label="Month ending" required>
              <input
                data-testid="ci-month"
                type="date"
                value={monthEnding}
                onChange={(e) => setMonthEnding(e.target.value)}
                className={inputCls}
              />
            </Q>
          </div>
        </Card>

        {/* ── 2 · the rating, first, because it is first on the card ── */}
        <Card n={2} title={CHECK_IN_SECTIONS[0].title} blurb={CHECK_IN_SECTIONS[0].blurb}>
          <Q label="Overall rating" required>
            {/* FIVE VISIBLE TILES. A <select> costs a tap, a scroll and a second tap on a phone and
                never says which end is good. Radios, so it is one control for a keyboard too. */}
            <div className="flex items-stretch gap-2" data-testid="ci-rating-scale">
              <span className="hidden shrink-0 items-center text-[11px] font-extrabold uppercase tracking-wider text-deep-green/45 sm:flex">
                {RATING_ANCHOR_LOW}
              </span>
              <div className="flex flex-1 gap-2">
                {RATING_OPTIONS.map((n) => (
                  <label key={n} className="relative flex-1">
                    <input
                      type="radio"
                      name="rating"
                      value={n}
                      checked={rating === String(n)}
                      onChange={() => setRating(String(n))}
                      className="absolute h-0 w-0 opacity-0"
                    />
                    <span
                      data-testid={`ci-rating-${n}`}
                      className={`flex h-[52px] cursor-pointer items-center justify-center rounded-xl border-[1.5px] text-lg font-extrabold tabular-nums transition ${
                        rating === String(n)
                          ? "border-deep-green bg-deep-green text-white"
                          : "border-cream-line bg-white text-deep-green hover:bg-cream-soft"
                      }`}
                    >
                      {n}
                    </span>
                  </label>
                ))}
              </div>
              <span className="hidden shrink-0 items-center text-[11px] font-extrabold uppercase tracking-wider text-deep-green/45 sm:flex">
                {RATING_ANCHOR_HIGH}
              </span>
            </div>
            {/* The anchors move under the tiles on a phone rather than disappearing — which end is
                good is the whole reason the scale beats a dropdown. */}
            <div className="mt-1.5 flex justify-between text-[11px] font-extrabold uppercase tracking-wider text-deep-green/45 sm:hidden">
              <span>{RATING_ANCHOR_LOW}</span>
              <span>{RATING_ANCHOR_HIGH}</span>
            </div>
          </Q>
        </Card>

        {/* ── 3,4,5 · the question sections, rendered FROM the list, in the list's order ── */}
        {CHECK_IN_SECTIONS.slice(1).map((sec, i) => (
          <Card key={sec.key} n={i + 3} title={sec.title} blurb={sec.blurb}>
            {CHECK_IN_QUESTIONS.filter((q) => q.section === sec.key).map((q) => (
              <Q key={q.key} label={q.label} hint={q.hint}>
                {q.kind === "short" ? (
                  <input
                    data-testid={`ci-${q.key}`}
                    inputMode="numeric"
                    value={answers[q.key]}
                    onChange={(e) => setAnswer(q.key, e.target.value, q.max)}
                    className={inputCls}
                  />
                ) : (
                  <textarea
                    data-testid={`ci-${q.key}`}
                    value={answers[q.key]}
                    onChange={(e) => setAnswer(q.key, e.target.value, q.max)}
                    rows={2}
                    className={`${inputCls} min-h-[76px] resize-y leading-relaxed`}
                  />
                )}
              </Q>
            ))}
          </Card>
        ))}

        {error && (
          <p
            data-testid="ci-error"
            className="mb-4 rounded-lg bg-coral-soft/60 px-3 py-2 text-sm font-medium text-coral-hover"
          >
            {error}
          </p>
        )}

        <button
          data-testid="ci-submit"
          type="submit"
          disabled={status === "saving"}
          className="w-full rounded-xl bg-mint px-5 py-3.5 text-[15px] font-extrabold text-deep-green transition hover:bg-mint-hover disabled:opacity-50"
        >
          {status === "saving" ? "Submitting…" : "Submit check-in"}
        </button>
      </form>
    </Shell>
  );
}

const inputCls =
  "w-full rounded-[10px] border-[1.5px] border-cream-line bg-white px-3 py-2.5 text-[14.5px] font-medium text-deep-green placeholder:text-deep-green/30 focus:border-mint focus:outline-none focus:ring-4 focus:ring-mint-soft/60";
const hintCls = "mt-1.5 block text-[12.5px] leading-snug text-deep-green/60";

/* A SECTION IS A CARD. Nine identical grey boxes in one column is what "hard to answer" meant:
   nothing told you where you were or how much was left. The n/N counter does. */
function Card({ n, title, blurb, children }: {
  n: number; title: string; blurb: string; children: React.ReactNode;
}) {
  return (
    <section
      data-testid={`ci-section-${n}`}
      className="mb-3.5 rounded-2xl border-[1.5px] border-cream-line bg-white p-[18px] pb-5 shadow-sm"
    >
      <div className="flex items-baseline gap-2.5">
        <span className="text-[11px] font-extrabold tracking-[0.08em] tabular-nums text-mint-hover">
          {n} / {TOTAL_SECTIONS}
        </span>
        <h2 className="text-[17px] font-extrabold tracking-tight text-deep-green">{title}</h2>
      </div>
      <p className="mb-4 mt-[3px] text-[13px] leading-snug text-deep-green/60">{blurb}</p>
      {children}
    </section>
  );
}

/* THE LABEL IS A QUESTION, NOT A COLUMN HEADER. The 11px uppercase tracking this replaced is a
   table header — it reads as chrome and the eye skips it. 14.5px sentence case is the thing asked. */
function Q({ label, required, hint, children }: {
  label: string; required?: boolean; hint?: string; children: React.ReactNode;
}) {
  return (
    <label className="mb-[17px] block last:mb-0">
      <span className="mb-0.5 block text-[14.5px] font-bold text-deep-green">
        {label}
        {required && <span className="text-mint-hover"> *</span>}
      </span>
      {hint && <span className={`${hintCls} mt-0 mb-[7px]`}>{hint}</span>}
      {children}
    </label>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-cream">
      <div className="bg-deep-green px-5 py-[18px]">
        <div className="mx-auto flex max-w-[640px] items-center gap-3">
          <span className="font-display text-xl italic tracking-wide text-mint">MATCHDAY</span>
          <span className="text-sm font-semibold text-cream/80">City Manager Check-In</span>
        </div>
      </div>
      <div className="mx-auto max-w-[640px] px-4 pb-16 pt-6">
        <div className="relative">
          <h1 className="mb-[18px] font-display text-3xl uppercase tracking-tight text-deep-green">
            Monthly check-in
          </h1>
          {children}
        </div>
      </div>
    </div>
  );
}

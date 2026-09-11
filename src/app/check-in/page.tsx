"use client";

// PUBLIC (no-login) City Manager Check-In form. Lives OUTSIDE the (internal) route group, so it
// inherits no auth — same placement and the same reasoning as /inventory. Reads NO data. Submits
// one row to /api/city-check-ins/submit, which is guarded (honeypot + IP rate limit + validation)
// and inserts with the service-role key; anon has no policies on the table at all.
//
// Ryan: "page like inventory link instead of forms. I want it to be open its not sensitive and not
// all city managers have the checkin". Some of the people who file this have no Clubhouse account,
// so this must not be behind /city/* and must not personalise anything.
//
// NO EXPLAINER COPY. No subtitle describing what a check-in is, no hint under any field, no legend
// under the rating. The question text is the only prose on the page.

import { useState } from "react";
import {
  CHECK_IN_QUESTIONS,
  CHECK_IN_CITY_OPTIONS,
  RATING_OPTIONS,
  defaultMonthEnding,
  MAX_NAME_LEN,
  type CheckInTextKey,
} from "@/lib/cityCheckIns";

type Answers = Record<CheckInTextKey, string>;
const EMPTY: Answers = Object.fromEntries(
  CHECK_IN_QUESTIONS.map((q) => [q.key, ""]),
) as Answers;

export default function CityCheckInPage() {
  const [name, setName] = useState("");
  const [city, setCity] = useState("");
  const [monthEnding, setMonthEnding] = useState(() => defaultMonthEnding(new Date()));
  const [rating, setRating] = useState("");
  const [answers, setAnswers] = useState<Answers>(EMPTY);
  const [website, setWebsite] = useState(""); // honeypot
  const [status, setStatus] = useState<"idle" | "saving" | "done">("idle");
  const [error, setError] = useState<string | null>(null);

  const setAnswer = (k: CheckInTextKey, v: string, max: number) =>
    setAnswers((a) => ({ ...a, [k]: v.slice(0, max) }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return setError("Please enter your name.");
    if (!city) return setError("Please pick your city.");
    if (!monthEnding) return setError("Please pick the month ending date.");
    if (!rating) return setError("Please pick an overall rating.");
    setStatus("saving");
    try {
      const res = await fetch("/api/city-check-ins/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          manager_name: name,
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
            Thanks{name.trim() ? `, ${name.trim().split(/\s+/)[0]}` : ""}!
          </h2>
          <p className="mt-2 text-sm text-deep-green/70">
            Your check-in was submitted. You can close this page.
          </p>
          <button
            type="button"
            onClick={() => {
              setName("");
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
      <form
        onSubmit={submit}
        className="rounded-2xl border border-cream-line bg-white p-6 shadow-sm sm:p-8"
      >
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

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Your name" required>
            <input
              data-testid="ci-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="First and last"
              maxLength={MAX_NAME_LEN}
              className={inputCls}
            />
          </Field>
          <Field label="City" required>
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
          </Field>
        </div>

        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <Field label="Month ending" required>
            <input
              data-testid="ci-month"
              type="date"
              value={monthEnding}
              onChange={(e) => setMonthEnding(e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label="Overall rating" required>
            <select
              data-testid="ci-rating"
              value={rating}
              onChange={(e) => setRating(e.target.value)}
              className={inputCls}
            >
              <option value="">Select…</option>
              {RATING_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {CHECK_IN_QUESTIONS.map((q) => (
          <div key={q.key} className="mt-5">
            <Field label={q.label}>
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
                  rows={3}
                  className={`${inputCls} resize-none`}
                />
              )}
            </Field>
          </div>
        ))}

        {error && (
          <p
            data-testid="ci-error"
            className="mt-4 rounded-lg bg-coral-soft/60 px-3 py-2 text-sm font-medium text-coral-hover"
          >
            {error}
          </p>
        )}

        <button
          data-testid="ci-submit"
          type="submit"
          disabled={status === "saving"}
          className="mt-6 w-full rounded-xl bg-mint px-5 py-3 text-sm font-extrabold text-deep-green transition hover:bg-mint-hover disabled:opacity-50"
        >
          {status === "saving" ? "Submitting…" : "Submit check-in"}
        </button>
      </form>
    </Shell>
  );
}

const inputCls =
  "w-full rounded-lg border border-cream-line bg-white px-3 py-2.5 text-sm font-semibold text-deep-green placeholder:text-deep-green/30 focus:border-mint focus:outline-none focus:ring-4 focus:ring-mint-soft/60";

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[11px] font-extrabold uppercase tracking-wide text-deep-green/50">
        {label}
        {required && <span className="text-mint-hover"> *</span>}
      </span>
      {children}
    </label>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-cream">
      <div className="bg-deep-green px-5 py-5">
        <div className="mx-auto flex max-w-lg items-center gap-3">
          <span className="font-display text-xl italic tracking-wide text-mint">MATCHDAY</span>
          <span className="text-sm font-semibold text-cream/80">City Manager Check-In</span>
        </div>
      </div>
      <div className="mx-auto max-w-lg px-4 py-8">
        <div className="relative">
          <h1 className="font-display text-3xl uppercase tracking-tight text-deep-green">
            Monthly check-in
          </h1>
          <div className="mt-6">{children}</div>
        </div>
      </div>
    </div>
  );
}

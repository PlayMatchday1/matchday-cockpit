"use client";

// PUBLIC (no-login) Equipment Inventory form. Lives outside the
// (internal) route group, so it inherits no auth. Submits one row to
// /api/inventory/submit (anon-insert RLS + server-side guards). Reads NO
// data. Styling is MatchDay-branded to spec now; it gets a final pass to
// match the approved mock.

import { useState } from "react";

const CITIES = [
  "Austin",
  "Dallas",
  "Houston",
  "San Antonio",
  "Atlanta",
  "St. Louis",
  "OKC",
  "El Paso",
] as const;

const BIBS = [
  { key: "white", label: "White", dot: "#e5e7eb", ring: "#cbd0d6" },
  { key: "green", label: "Green", dot: "#2fbf6c", ring: "#2fbf6c" },
  { key: "orange", label: "Orange", dot: "#e8862b", ring: "#e8862b" },
  { key: "blue", label: "Blue", dot: "#3b82f6", ring: "#3b82f6" },
] as const;

type Counts = Record<"white" | "green" | "orange" | "blue" | "balls", string>;

const ZERO: Counts = { white: "", green: "", orange: "", blue: "", balls: "" };

export default function InventoryFormPage() {
  const [name, setName] = useState("");
  const [city, setCity] = useState("");
  const [counts, setCounts] = useState<Counts>(ZERO);
  const [needs, setNeeds] = useState("");
  const [website, setWebsite] = useState(""); // honeypot
  const [status, setStatus] = useState<"idle" | "saving" | "done">("idle");
  const [error, setError] = useState<string | null>(null);

  const setCount = (k: keyof Counts, v: string) =>
    setCounts((c) => ({ ...c, [k]: v.replace(/[^\d]/g, "").slice(0, 3) }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return setError("Please enter your name.");
    if (!city) return setError("Please pick your city.");
    setStatus("saving");
    try {
      const res = await fetch("/api/inventory/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, city, ...counts, needs, website }),
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
            Thanks{ name.trim() ? `, ${name.trim().split(/\s+/)[0]}` : "" }!
          </h2>
          <p className="mt-2 text-sm text-deep-green/70">
            Your equipment count was submitted. You can close this page.
          </p>
          <button
            type="button"
            onClick={() => {
              setName("");
              setCity("");
              setCounts(ZERO);
              setNeeds("");
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
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="First and last"
              maxLength={120}
              className={inputCls}
            />
          </Field>
          <Field label="City" required>
            <select
              value={city}
              onChange={(e) => setCity(e.target.value)}
              className={inputCls}
            >
              <option value="">Select your city…</option>
              {CITIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="mt-6">
          <div className="text-[11px] font-extrabold uppercase tracking-wide text-deep-green/50">
            Bib sets on hand
          </div>
          <div className="mb-2 text-[11px] text-deep-green/40">
            1 set = enough for 1 team at your fields
          </div>
          <div className="flex flex-col gap-2">
            {BIBS.map((b) => (
              <div
                key={b.key}
                className="flex items-center gap-3 rounded-lg border border-cream-line px-3 py-2"
              >
                <span
                  className="inline-block h-3.5 w-3.5 rounded-full"
                  style={{ background: b.dot, boxShadow: `inset 0 0 0 1px ${b.ring}` }}
                />
                <span className="flex-1 text-sm font-bold text-deep-green">
                  {b.label}
                </span>
                <input
                  inputMode="numeric"
                  value={counts[b.key]}
                  onChange={(e) => setCount(b.key, e.target.value)}
                  placeholder="0"
                  aria-label={`${b.label} bib sets`}
                  className="w-[70px] rounded-lg border border-cream-line bg-white px-2 py-2 text-center text-sm font-extrabold tabular-nums text-deep-green focus:border-mint focus:outline-none focus:ring-4 focus:ring-mint-soft/60"
                />
              </div>
            ))}
          </div>
        </div>

        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <Field label="MatchDay balls">
            <input
              inputMode="numeric"
              value={counts.balls}
              onChange={(e) => setCount("balls", e.target.value)}
              placeholder="0"
              className={`${inputCls} tabular-nums`}
            />
          </Field>
        </div>

        <div className="mt-5">
          <Field label="Anything you need?">
            <textarea
              value={needs}
              onChange={(e) => setNeeds(e.target.value.slice(0, 500))}
              rows={3}
              placeholder="Optional — e.g. more orange bibs, a pump…"
              className={`${inputCls} resize-none`}
            />
          </Field>
        </div>

        {error && (
          <p className="mt-4 rounded-lg bg-coral-soft/60 px-3 py-2 text-sm font-medium text-coral-hover">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={status === "saving"}
          className="mt-6 w-full rounded-xl bg-mint px-5 py-3 text-sm font-extrabold text-deep-green transition hover:bg-mint-hover disabled:opacity-50"
        >
          {status === "saving" ? "Submitting…" : "Submit inventory"}
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
          <span className="font-display text-xl italic tracking-wide text-mint">
            MATCHDAY
          </span>
          <span className="text-sm font-semibold text-cream/80">
            Equipment Inventory
          </span>
        </div>
      </div>
      <div className="mx-auto max-w-lg px-4 py-8">
        <div className="relative">
          <h1 className="font-display text-3xl uppercase tracking-tight text-deep-green">
            Equipment count
          </h1>
          <p className="mt-1 text-sm text-deep-green/60">
            Tell us what gear you have on hand. Takes ~30 seconds.
          </p>
          <div className="mt-6">{children}</div>
        </div>
      </div>
    </div>
  );
}

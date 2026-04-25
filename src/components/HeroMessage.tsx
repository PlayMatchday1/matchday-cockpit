"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

const FALLBACK =
  "Building the premier pickup soccer experience. From Austin to El Paso, we're rewriting how the world plays. 8 cities down. The whole map next.";

export default function HeroMessage() {
  const [value, setValue] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("app_settings")
        .select("value")
        .eq("key", "hero_message")
        .maybeSingle();
      if (cancelled) return;
      setValue(error ? FALLBACK : (data?.value ?? FALLBACK));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function save() {
    const next = draft.trim();
    if (!next) return;
    setSaving(true);
    const { error } = await supabase.from("app_settings").upsert(
      {
        key: "hero_message",
        value: next,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "key" },
    );
    setSaving(false);
    if (error) {
      alert(error.message);
      return;
    }
    setValue(next);
    setEditing(false);
  }

  if (value === null) {
    return <div className="mb-10 h-32 animate-pulse rounded-2xl bg-deep-green/80" />;
  }

  return (
    <section className="group relative mb-10 overflow-hidden rounded-2xl bg-deep-green px-6 py-6 shadow-sm md:px-8 md:py-7">
      {!editing && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-6 hidden flex-col justify-center gap-1 md:flex"
        >
          <span className="block h-14 w-1 rounded-full bg-mint/25" />
          <span className="block h-14 w-1 rounded-full bg-mint/55" />
          <span className="block h-14 w-1 rounded-full bg-mint" />
        </div>
      )}

      {!editing && (
        <button
          type="button"
          onClick={() => {
            setDraft(value);
            setEditing(true);
          }}
          className="absolute right-3 top-3 rounded-full p-1.5 text-cream/40 opacity-0 transition hover:bg-cream/10 hover:text-cream group-hover:opacity-100 focus-visible:opacity-100"
          aria-label="Edit message"
        >
          <svg
            className="h-3.5 w-3.5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
          </svg>
        </button>
      )}

      <div className="relative max-w-2xl pr-6 md:pr-12">
        <div className="text-[11px] font-bold uppercase tracking-[0.28em] text-mint">
          MatchDay Mission
        </div>

        {editing ? (
          <>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={3}
              autoFocus
              className="mt-3 w-full resize-none rounded-lg border border-cream/20 bg-deep-green-hover px-4 py-3 font-display text-2xl uppercase leading-[1.05] tracking-tight text-cream focus:border-mint focus:outline-none md:text-3xl"
            />
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setEditing(false);
                  setDraft(value);
                }}
                className="rounded-full px-4 py-1.5 text-sm font-medium text-cream/70 hover:text-cream"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={save}
                disabled={saving || !draft.trim()}
                className="rounded-full bg-mint px-5 py-1.5 text-sm font-bold text-deep-green transition hover:bg-mint-hover disabled:opacity-50"
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </>
        ) : (
          <p className="mt-2 font-display text-2xl uppercase leading-[1.05] tracking-tight text-cream md:text-3xl">
            {value}
          </p>
        )}
      </div>
    </section>
  );
}

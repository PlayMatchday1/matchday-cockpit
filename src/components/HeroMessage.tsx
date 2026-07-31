"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

const FALLBACK =
  "Building the premier pickup soccer experience. From Austin to Atlanta. 7 cities down. The whole map next.";

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
    return <div className="mb-4 h-6 w-2/3 animate-pulse rounded bg-[#e0f2e7]" />;
  }

  // Lighter inline mission (mockup's .mission): a MATCHDAY MISSION kicker pill
  // in mint + the mission sentence on the cream background. Retains the
  // app_settings-backed inline edit (hover pencil).
  if (!editing) {
    return (
      <div className="group relative mb-4 flex flex-wrap items-baseline gap-3 pb-4 pr-8">
        <span
          className="rounded-md px-[9px] py-[4px] text-[10px] font-[750] uppercase tracking-[0.13em]"
          style={{ color: "#35c77f", background: "#e0f2e7" }}
        >
          MatchDay mission
        </span>
        <p className="m-0 text-[14px] font-medium" style={{ color: "#365449" }}>
          {value}
        </p>
        <button
          type="button"
          onClick={() => {
            setDraft(value);
            setEditing(true);
          }}
          aria-label="Edit message"
          className="absolute right-0 top-0 rounded-full p-1.5 text-deep-green/30 opacity-0 transition hover:bg-deep-green/10 hover:text-deep-green group-hover:opacity-100 focus-visible:opacity-100"
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
      </div>
    );
  }

  return (
    <div className="mb-4 pb-4">
      <span
        className="mb-2 inline-block rounded-md px-[9px] py-[4px] text-[10px] font-[750] uppercase tracking-[0.13em]"
        style={{ color: "#35c77f", background: "#e0f2e7" }}
      >
        MatchDay mission
      </span>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={2}
        autoFocus
        className="mt-1 w-full resize-none rounded-lg border border-cream-line bg-white px-3 py-2 text-[14px] text-[#365449] focus:border-mint focus:outline-none"
      />
      <div className="mt-2 flex justify-end gap-2">
        <button
          type="button"
          onClick={() => {
            setEditing(false);
            setDraft(value);
          }}
          className="rounded-full px-4 py-1.5 text-sm font-medium text-deep-green/70 hover:text-deep-green"
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
    </div>
  );

}

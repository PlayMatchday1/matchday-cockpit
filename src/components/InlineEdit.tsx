"use client";

import { useState } from "react";

export default function InlineEdit({
  value,
  onSave,
  className,
  inputClassName,
  placeholder,
}: {
  value: string;
  onSave: (next: string) => void;
  className?: string;
  inputClassName?: string;
  placeholder?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={() => {
          if (draft !== value) onSave(draft);
          setEditing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            (e.target as HTMLInputElement).blur();
          } else if (e.key === "Escape") {
            setDraft(value);
            setEditing(false);
          }
        }}
        placeholder={placeholder}
        className={`rounded border border-mint bg-white px-1 py-0 outline-none ${inputClassName ?? ""}`}
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => {
        setDraft(value);
        setEditing(true);
      }}
      className={`rounded px-1 text-left hover:bg-cream-soft ${className ?? ""}`}
    >
      {value || (
        <span className="italic text-deep-green/30">{placeholder ?? "—"}</span>
      )}
    </button>
  );
}

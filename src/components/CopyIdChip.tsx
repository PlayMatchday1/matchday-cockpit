"use client";

// Small click-to-copy match-id chip. One shared helper so the Match Chats
// header and the Veo review queue read as the same thing: muted, monospace
// "ID <n>" with a copy icon that flips to a check on copy. Size/color inherit
// from the parent (pass extra classes if needed).

import { useState } from "react";
import { Check, Copy } from "lucide-react";

export default function CopyIdChip({
  id,
  className = "",
  title = "Copy match ID — paste it into the Veo queue to assign a recording",
}: {
  id: string | number;
  className?: string;
  title?: string;
}) {
  const [copied, setCopied] = useState(false);
  const value = String(id);
  return (
    <button
      type="button"
      title={title}
      onClick={async (e) => {
        // Stop the click from bubbling to any enclosing action (e.g. a
        // candidate row's assign button).
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard unavailable — the id is still shown to read off */
        }
      }}
      className={`inline-flex shrink-0 items-center gap-1 font-mono font-medium text-deep-green/45 transition hover:text-deep-green/70 ${className}`}
    >
      ID {value}
      {copied ? (
        <Check aria-hidden className="h-3 w-3 text-mint-hover" />
      ) : (
        <Copy aria-hidden className="h-3 w-3" />
      )}
    </button>
  );
}

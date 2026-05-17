"use client";

// Segmented control toggling between /chats (Players) and /match-chats
// (Matches). Both halves are <Link>s so the browser handles navigation;
// the `current` prop decides which side shows the filled active state.
//
// Lifted out of /chats/CrmClient.tsx so /match-chats can render the
// same control inside its own header. No outer row chrome here — the
// caller supplies whatever padding/background row it lives in.

import Link from "next/link";

type Current = "players" | "matches";

export default function PlayersMatchesToggle({
  current,
}: {
  current: Current;
}) {
  return (
    <div className="grid grid-cols-2 gap-1 rounded-full border border-deep-green/15 bg-white p-0.5">
      <SegmentLink href="/chats" label="Players" active={current === "players"} />
      <SegmentLink
        href="/match-chats"
        label="Matches"
        active={current === "matches"}
      />
    </div>
  );
}

function SegmentLink({
  href,
  label,
  active,
}: {
  href: string;
  label: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      style={{ touchAction: "manipulation" }}
      className={`flex h-9 items-center justify-center rounded-full text-sm font-medium transition ${
        active
          ? "bg-deep-green text-cream"
          : "text-deep-green/60 hover:bg-cream-soft hover:text-deep-green"
      }`}
    >
      {label}
    </Link>
  );
}

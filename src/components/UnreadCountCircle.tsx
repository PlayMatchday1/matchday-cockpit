// Small count pill for nav unread badges. Renders nothing at count <= 0
// (or a non-finite count) so consumers can mount it unconditionally and
// the badge simply disappears at zero / on any bad value. Caps display at
// "99+" so a runaway count can't blow out the nav layout.

export default function UnreadCountCircle({
  count,
  size = "md",
}: {
  count: number;
  size?: "md" | "sm";
}) {
  if (!Number.isFinite(count) || count <= 0) return null;
  const label = count > 99 ? "99+" : String(count);
  const dims =
    size === "sm"
      ? "h-[14px] min-w-[14px] px-1 text-[9px]"
      : "h-[18px] min-w-[18px] px-1.5 text-[10px]";
  return (
    <span
      aria-label={`${count} unread customer ${count === 1 ? "chat" : "chats"}`}
      className={`inline-flex items-center justify-center rounded-full bg-coral font-bold leading-none text-white tabular-nums ${dims}`}
    >
      {label}
    </span>
  );
}

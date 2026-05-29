"use client";

// useFaviconUnreadDot — Trello-style favicon presence dot.
//
// Swaps the SVG favicon to a variant with a small red dot when there are
// unread chats, and back to the clean badge when the count is zero. Presence
// only, no number. Reuses whatever count is passed in (the caller threads in
// useCrmUnreadCount) so there is no second data source.
//
// SAFETY: the base favicon asset is never touched. We only flip the href of
// the existing <link rel="icon" type="image/svg+xml"> between the base (read
// off the element at mount, so it stays canonical) and the unread variant.
// If that link is missing, or count is 0 / null / undefined / NaN, the
// favicon is left in / restored to the clean state. On unmount we restore the
// base href so a stale dot never persists after navigating away.

import { useEffect } from "react";

const UNREAD_ICON = "/matchday-badge-unread.svg";

export function useFaviconUnreadDot(count: number | null | undefined): void {
  const hasUnread = typeof count === "number" && Number.isFinite(count) && count > 0;

  useEffect(() => {
    if (typeof document === "undefined") return;

    // The SVG icon link is the one browsers actually render in the tab.
    const link = document.querySelector<HTMLLinkElement>(
      'link[rel~="icon"][type="image/svg+xml"]',
    );
    if (!link) return; // No swappable link → leave the favicon alone.

    // Capture the canonical base href once, before we ever mutate it, so the
    // clean state always restores to exactly what Next rendered.
    const baseHref = link.dataset.baseHref ?? link.getAttribute("href") ?? "";
    if (!baseHref) return;
    link.dataset.baseHref = baseHref;

    const desired = hasUnread ? UNREAD_ICON : baseHref;
    if (link.getAttribute("href") !== desired) {
      link.setAttribute("href", desired);
    }

    // Cleanup: always fall back to the clean base favicon on unmount.
    return () => {
      if (link.getAttribute("href") !== baseHref) {
        link.setAttribute("href", baseHref);
      }
    };
  }, [hasUnread]);
}

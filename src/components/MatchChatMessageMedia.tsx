// Renders the media portion of a match-chat message. Dispatches on
// the `messageType` classification:
//   Image → inline <img> with object-fit and lazy load, clickable
//           to open full-size in a new tab.
//   Video → <video controls preload="metadata">.
//   Other → "📎 Attachment — open in mobile app" placeholder.
//
// Text-only messages don't render this component at all.

import { classifyMessage, messageMediaUrl } from "@/lib/matchChats";
import type { FirestoreMessage } from "@/lib/matchChats";

export default function MatchChatMessageMedia({
  msg,
}: {
  msg: FirestoreMessage;
}) {
  const kind = classifyMessage(msg);
  const url = messageMediaUrl(msg);

  if (kind === "Image" && url) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="block overflow-hidden rounded-md border border-cream-line bg-cream-soft"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt="Shared image"
          loading="lazy"
          className="max-h-72 w-auto object-contain"
        />
      </a>
    );
  }
  if (kind === "Video" && url) {
    return (
      <video
        src={url}
        controls
        preload="metadata"
        className="max-h-72 w-full rounded-md border border-cream-line bg-deep-green/5"
      />
    );
  }
  // Unknown type, or media URL missing — render a non-broken
  // placeholder rather than guessing.
  return (
    <div className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-cream-line bg-cream-soft px-2.5 py-1.5 text-xs text-deep-green/55">
      <span aria-hidden>📎</span>
      Attachment — open in mobile app
    </div>
  );
}

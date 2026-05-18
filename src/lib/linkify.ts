// Shared linkify-react config used by both chat bubble renderers
// (src/app/(internal)/chats/components/MessageBubble.tsx and
// src/app/(internal)/match-chats/ChatPane.tsx).
//
// URLs only — email/hashtag/mention auto-detection are off because
// CRM message bodies contain raw phone numbers, names, and other
// content where those parsers produce noise more often than signal.
//
// All auto-detected URLs open in a new tab with the standard
// noopener-noreferrer security pair so a malicious target page
// can't get a handle on this window via window.opener.

import type { Opts } from "linkifyjs";

export const LINKIFY_OPTIONS: Opts = {
  target: "_blank",
  rel: "noopener noreferrer",
  className: "underline decoration-deep-green/40 hover:decoration-deep-green",
  validate: {
    email: false,
    hashtag: false,
    mention: false,
  },
};

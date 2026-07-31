// Convert stored rich-text HTML (goal_comments.body, etc.) to plain text for
// previews. NOT for full rendering — the full comment view sanitizes with
// DOMPurify (see CommentBody). This is deliberately dumb string work so it can
// never be an injection vector: the result is plain text that goes through
// normal React escaping at the call site.
//
// Order matters: convert block/line closers to spaces and strip all tags BEFORE
// decoding entities, so a decoded "&lt;" can't be mistaken for a tag and
// stripped.

export function htmlToPlainText(html: string | null | undefined): string {
  if (!html) return "";
  let s = html;
  // Block / line-break closers → a single space so words don't run together.
  s = s.replace(/<\/(p|div|li)\s*>/gi, " ").replace(/<br\s*\/?>/gi, " ");
  // Strip every remaining tag.
  s = s.replace(/<[^>]*>/g, "");
  // Decode the common named/numeric entities.
  s = s
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, "&"); // last, so "&amp;lt;" → "&lt;" not "<"
  // Collapse whitespace runs and trim.
  return s.replace(/\s+/g, " ").trim();
}
